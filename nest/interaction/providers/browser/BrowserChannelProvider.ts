/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/utils/dbErrors';
import { InteractionUserChannelEntity } from '../../entities/InteractionUserChannelEntity';
import { InteractionWebPushSubscriptionEntity } from '../../entities/InteractionWebPushSubscriptionEntity';
import { InteractionError } from '../../errors/InteractionError';
import type { WebPushSubscribeBody } from '../../pure/bodies';
import { InteractionConfig } from '../../services/InteractionConfig';
import { InteractionRenderer } from '../../services/InteractionRenderer';
import type { InteractionCapability, InteractionProof } from '../../types/interactionTypes';
import type { InteractionRuntimeOptions } from '../../interactionOptions';
import { constantTimeEqual } from '../../pure/codes';
import { isAllowedPushEndpoint } from '../../pure/pushHosts';
import { INTERACTION_OPTIONS, INTERACTION_VAPID_KEYS, type VapidKeySource } from '../../types/ports';
import type { ChannelConfigureResult, ChannelOwner, ChannelReadiness, ChannelSendResult, InteractionChannelProvider, RenderedMessage, SendContext, StoredChannel } from '../../types/providerTypes';
import { WebPushSender } from './WebPushSender';

const MAX_SUBSCRIPTIONS_PER_USER = 20;
/** The VAPID `sub` given to a push host off the list when no `https` site URL is configured (RFC 2606 reserved domain). */
export const NEUTRAL_VAPID_SUBJECT = 'mailto:webpush@example.invalid';

/**
 * The browser channel (04 §5): Web Push (VAPID, `web-push`) to every browser the user subscribed. A subscription gone
 * at the push service (404 / 410) is deleted. With the tab open, the in-app notice arrives through the event stream and
 * the front decides between a toast and a native notification (04 §10.4); a question is a notice with a link (no answer
 * from a system notification: `notify` + `open` only). Endpoints are targets: never in a view, a log or an event.
 */
@Injectable()
export class BrowserChannelProvider implements InteractionChannelProvider<{ enabled?: boolean }> {
  readonly kind = 'browser';
  readonly capabilities: ReadonlySet<InteractionCapability> = new Set<InteractionCapability>(['notify', 'open']);
  /** A system notification only leads into the app (04 §22). */
  readonly proof: InteractionProof = 'link';
  readonly requiresVerification = false;
  readonly configSchema = {
    parse: (input: unknown): { enabled?: boolean } => {
      const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new InteractionError('INVALID_CONFIG', { field: 'enabled', reason: 'BOOLEAN_REQUIRED' });
      return body.enabled === undefined ? {} : { enabled: body.enabled as boolean };
    },
    secretFields: [] as const,
  };

  constructor(
    @InjectRepository(InteractionWebPushSubscriptionEntity) private readonly subscriptions: Repository<InteractionWebPushSubscriptionEntity>,
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    @Inject(INTERACTION_VAPID_KEYS) private readonly vapid: VapidKeySource,
    private readonly sender: WebPushSender,
    private readonly renderer: InteractionRenderer,
    private readonly config: InteractionConfig,
    @Inject(INTERACTION_OPTIONS) private readonly options: Pick<InteractionRuntimeOptions, 'pushHosts' | 'allowAnyPublicPushHost'>,
  ) {}

  async configure(owner: ChannelOwner, input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> {
    const body = this.configSchema.parse(input);
    const base: StoredChannel = current ?? { id: '', userId: owner.userId, kind: this.kind, enabled: true, adminDisabled: false, position: 0, config: {}, verification: null, secretId: null, externalKey: null, verifiedAt: null };
    return { channel: { ...base, enabled: body.enabled ?? base.enabled, config: { webPush: true } }, secretOnce: null };
  }

  async verify(): Promise<StoredChannel> {
    throw new InteractionError('VERIFICATION_FAILED', { reason: 'NO_PENDING' });
  }

  async isReady(channel: StoredChannel): Promise<boolean> {
    return (await this.readiness(channel)).ready;
  }

  async readiness(channel: StoredChannel): Promise<ChannelReadiness> {
    return (await this.subscriptions.count({ where: { userId: channel.userId } })) > 0 ? { ready: true, code: null } : { ready: false, code: 'NO_SUBSCRIPTION' };
  }

  /** `GET /me/webpush/public-key`. */
  async publicKey(): Promise<string> {
    return (await this.vapid.keys()).publicKey;
  }

  /**
   * `POST /me/webpush/subscriptions`: this browser now belongs to the session user (upsert by endpoint). Safe under
   * parallel calls (04 §17 concurrency kit): the channel row is ensured FIRST (a concurrent first insert is re-read, so
   * a subscription never exists without its channel), the subscription is inserted or, when its endpoint exists,
   * updated (never a raw unique violation), and the cap of 20 browsers is « record then count »: a new row that makes
   * more than 20 is withdrawn (`RATE_LIMITED`), so parallel subscriptions never leave more than 20. Refused for a
   * channel an administrator disabled. Review F8: the endpoint must be on a known push service (`DEFAULT_PUSH_HOSTS` +
   * `pushHostAllowlist`, unless `allowAnyPublicPushHost`). An endpoint registered by ANOTHER user moves to this one only
   * with the SAME `p256dh` and `auth` (second review, finding 4: proof that this is that very browser, e.g. a shared
   * device whose previous user did not log out); otherwise the same `INVALID_INPUT { field: 'endpoint' }` as a malformed
   * endpoint.
   */
  async subscribe(owner: ChannelOwner, body: WebPushSubscribeBody): Promise<void> {
    if (!this.options.allowAnyPublicPushHost && !isAllowedPushEndpoint(body.endpoint, this.options.pushHosts)) throw new InteractionError('INVALID_INPUT', { field: 'endpoint' });
    const channel = await this.ensureChannel(owner.userId);
    if (channel.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    const { id, added } = await this.upsertSubscription(owner.userId, body);
    if (!added) return;
    if ((await this.subscriptions.count({ where: { userId: owner.userId } })) > MAX_SUBSCRIPTIONS_PER_USER) {
      await this.subscriptions.delete({ id, userId: owner.userId });
      throw new InteractionError('RATE_LIMITED', { cap: 'user' }, 3600);
    }
  }

  /** The user's browser channel row, created on the first subscription (a lost first-insert race reads the winner's). */
  private async ensureChannel(userId: number): Promise<InteractionUserChannelEntity> {
    const existing = await this.channels.findOne({ where: { userId, kind: this.kind } });
    if (existing) return existing;
    try {
      await this.channels.insert({ userId, kind: this.kind, enabled: true, adminDisabled: false, position: 0, config: { webPush: true }, verification: null, secretId: null, externalKey: null, verifiedAt: new Date() });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.channels.findOneOrFail({ where: { userId, kind: this.kind } });
  }

  /**
   * INSERT, or UPDATE of the user's OWN row holding this endpoint (the browser renewed its keys), or MOVE of another
   * user's row when the posted keys are the stored ones (same browser): `added` when the row is new for this user, i.e.
   * when the cap must be checked. Another user's row with other keys is refused, never moved.
   */
  private async upsertSubscription(userId: number, body: WebPushSubscribeBody): Promise<{ id: string; added: boolean }> {
    const fields = { p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: body.userAgent };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.subscriptions.findOne({ where: { endpoint: body.endpoint } });
      if (existing && existing.userId !== userId) {
        if (!constantTimeEqual(existing.p256dh, body.keys.p256dh) || !constantTimeEqual(existing.auth, body.keys.auth)) throw new InteractionError('INVALID_INPUT', { field: 'endpoint' });
        // Moved only while it still is that user's row with those very keys (a concurrent change refuses the move).
        const moved = await this.subscriptions.update({ id: existing.id, userId: existing.userId, p256dh: existing.p256dh, auth: existing.auth }, { userId, userAgent: body.userAgent });
        if ((moved.affected ?? 0) > 0) return { id: existing.id, added: true };
        continue;
      }
      if (existing) {
        const result = await this.subscriptions.update({ id: existing.id, userId }, fields);
        if ((result.affected ?? 0) > 0) return { id: existing.id, added: false };
        continue; // removed meanwhile: insert it
      }
      const id = randomUUID();
      try {
        await this.subscriptions.insert({ id, endpoint: body.endpoint, lastUsedAt: null, userId, ...fields });
        return { id, added: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new InteractionError('UPSTREAM_UNAVAILABLE');
  }

  /** `DELETE /me/webpush/subscriptions`: only the session user's own browser. */
  async unsubscribe(owner: ChannelOwner, endpoint: string): Promise<void> {
    await this.subscriptions.delete({ endpoint, userId: owner.userId });
  }

  async send(ctx: SendContext, message: RenderedMessage): Promise<ChannelSendResult> {
    const userId = ctx.channel?.userId ?? message.userId;
    const rows = await this.subscriptions.find({ where: { userId }, take: MAX_SUBSCRIPTIONS_PER_USER });
    if (rows.length === 0) return { ok: false, code: 'NO_SUBSCRIPTION' };
    let keys: { publicKey: string; privateKey: string; subject: string };
    try {
      keys = await this.vapid.keys();
    } catch (error) {
      return { ok: false, code: error instanceof InteractionError ? error.code : 'NOT_CONFIGURED' };
    }
    const title = ctx.ping ? await this.renderer.server('interaction.server.browser.testTitle', message.locale) : message.title;
    const body = ctx.ping ? await this.renderer.server('interaction.server.browser.testBody', message.locale) : message.body;
    const url = message.question?.openUrl ?? message.url;
    const payload = JSON.stringify({ title, body, url, tag: url ? `vx-interaction:${url}` : `vx-interaction:${message.deliveryId}`, id: message.deliveryId });
    const timeoutMs = this.config.providerTimeoutMs();
    let sent = 0;
    let lastCode: string | null = null;
    await Promise.all(
      rows.map(async (row) => {
        // A host off the push services' list: refused, unless the app allows any public host, and then it never gets
        // the app's VAPID contact (`sub`), only a neutral one (review F8).
        const known = isAllowedPushEndpoint(row.endpoint, this.options.pushHosts);
        if (!known && !this.options.allowAnyPublicPushHost) {
          lastCode = 'ADDRESS_REFUSED';
          return;
        }
        const result = await this.sender.send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, payload, known ? keys : { ...keys, subject: this.neutralSubject() }, timeoutMs);
        if (result.ok) {
          sent += 1;
          await this.subscriptions.update({ id: row.id }, { lastUsedAt: new Date() }).catch(() => undefined);
          return;
        }
        lastCode = result.code;
        if (result.status === 404 || result.status === 410) await this.subscriptions.delete({ id: row.id }).catch(() => undefined);
      }),
    );
    return sent > 0 ? { ok: true, code: null } : { ok: false, code: lastCode ?? 'ERROR' };
  }

  /** The VAPID `sub` a host off the push services' list gets: the public site URL, never the app's contact address. */
  private neutralSubject(): string {
    const site = this.renderer.absoluteUrl('/');
    return site && /^https:\/\/[^/]+/.test(site) ? (/^https:\/\/[^/]+/.exec(site) as RegExpExecArray)[0] : NEUTRAL_VAPID_SUBJECT;
  }

  /** The owner's view: how many browsers (never an endpoint), with their user agent to recognise them. */
  async ownerView(channel: StoredChannel): Promise<Record<string, unknown>> {
    const rows = await this.subscriptions.find({ where: { userId: channel.userId }, order: { createdAt: 'ASC' } });
    return { subscriptions: rows.length, devices: rows.map((row) => ({ id: row.id, userAgent: row.userAgent, createdAt: row.createdAt.toISOString() })) };
  }

  async adminView(channel: StoredChannel): Promise<Record<string, string | number | boolean | null>> {
    return { subscriptions: await this.subscriptions.count({ where: { userId: channel.userId } }) };
  }

  async onRemove(channel: StoredChannel): Promise<void> {
    await this.subscriptions.delete({ userId: channel.userId });
  }
}
