/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, LessThan, MoreThan, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/dbErrors';
import { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import type { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { toStoredChannel } from '../mappers/InteractionMapper';
import { sourceDedupKey } from '../pure/codes';
import { planDelivery } from '../pure/deliveryPlan';
import { BODY_MAX, TITLE_MAX, safeText } from '../pure/text';
import { validateNotice, type CleanNotice } from '../pure/validation';
import type { DeliveryEntry, DeliveryReport, DeliveryStatus, InteractionCategory, InteractionPriority, UserNotice } from '../types/interactionTypes';
import { INTERACTION_DIRECTORY, type InteractionDirectory } from '../types/ports';
import type { ChannelSendResult, InteractionChannelProvider, RenderedMessage, StoredChannel } from '../types/providerTypes';
import { InteractionChannelService, safeCode } from './InteractionChannelService';
import { InteractionConfig } from './InteractionConfig';
import { InteractionInboxService } from './InteractionInboxService';
import { INAPP_KIND, InteractionProviderRegistry } from './InteractionProviderRegistry';
import { InteractionPrefService } from './InteractionPrefService';
import { InteractionRenderer } from './InteractionRenderer';
import { errorCode, InteractionHooks } from './InteractionRuntime';

const HOUR_MS = 3_600_000;
const ACTIVE_STATUSES = ['sent', 'queued'];

/** What identifies a delivery in the journal (never a content). */
export interface DeliveryMeta {
  dedupKey: string;
  category: InteractionCategory;
  priority: InteractionPriority;
  type: string;
  ticketId: string | null;
}

/** One external channel of a plan once reserved. */
export interface ReservedDelivery {
  kind: string;
  deliveryId: string | null;
  status: DeliveryStatus;
  code: string | null;
  channel: InteractionUserChannelEntity;
  provider: InteractionChannelProvider;
}

/** Builds the message of one channel (title, body, link, question) for a reserved delivery. */
export type MessageBuilder = (kind: string, deliveryId: string, provider: InteractionChannelProvider) => Promise<RenderedMessage>;

/**
 * The delivery algorithm (04 §7): validate and render, inactive users get nothing, `inapp` first and always, then the
 * external channels of the plan (routing, never-silent fallback, quiet hours), each reserved in `interaction_delivery`
 * BEFORE it is sent (unique `(user, dedup_key, kind)`: a duplicate sends nothing), capped (« record then count »), sent
 * concurrently under a per-provider timeout. A provider's failure never blocks another one (invariant 8). The journal
 * holds codes and ids only.
 */
@Injectable()
export class InteractionDeliveryService {
  private readonly logger = new Logger('InteractionDelivery');

  constructor(
    @InjectRepository(InteractionDeliveryEntity) private readonly deliveries: Repository<InteractionDeliveryEntity>,
    private readonly channels: InteractionChannelService,
    private readonly registry: InteractionProviderRegistry,
    private readonly prefs: InteractionPrefService,
    private readonly renderer: InteractionRenderer,
    private readonly inbox: InteractionInboxService,
    private readonly hooks: InteractionHooks,
    private readonly config: InteractionConfig,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
  ) {}

  /** `notify` for one user. `excludeKinds`: external kinds left out on purpose. */
  async notify(userId: number, input: UserNotice, options: { excludeKinds?: string[] } = {}): Promise<DeliveryReport> {
    const notice = validateNotice(input);
    if (!(await this.directory.isActive(userId))) return { userId, noticeId: null, outcome: 'inactive', deliveries: [] };
    // The app's key is namespaced by the notice's source (review F8); without one, a random key (always delivered).
    const meta: DeliveryMeta = { dedupKey: notice.dedupKey ? sourceDedupKey(notice.source, notice.dedupKey) : `r:${randomUUID()}`, category: notice.category, priority: notice.priority, type: notice.type, ticketId: null };
    const entries: DeliveryEntry[] = [];
    let noticeId: string | null = null;
    if ((await this.reserve(userId, INAPP_KIND, meta, 'sent', null)).status === 'duplicate') {
      entries.push({ kind: INAPP_KIND, status: 'duplicate', code: null });
    } else {
      noticeId = await this.inbox.write(userId, notice, null);
      entries.push({ kind: INAPP_KIND, status: 'sent', code: null });
    }
    const reserved = await this.planAndReserve(userId, meta, options.excludeKinds ?? []);
    const lang = await this.renderer.localeOf(userId);
    const title = await this.renderer.render(notice.title, lang, TITLE_MAX);
    const body = notice.body ? await this.renderer.render(notice.body, lang, BODY_MAX) : '';
    const build: MessageBuilder = async (kind, deliveryId) => this.message(kind, { deliveryId, userId, locale: lang, category: notice.category, type: notice.type, title, body, url: this.renderer.absoluteUrl(notice.url) });
    entries.push(...(await this.sendReserved(userId, reserved, build)));
    return report(userId, noticeId, entries);
  }

  /** The in-app delivery row of a ticket (`t:<ticketId>`). */
  async reserveInapp(userId: number, meta: DeliveryMeta): Promise<DeliveryStatus> {
    return (await this.reserve(userId, INAPP_KIND, meta, 'sent', null)).status;
  }

  /** Steps 3-7 of 04 §7: the plan, its reservation, the caps. */
  async planAndReserve(userId: number, meta: DeliveryMeta, excludeKinds: string[]): Promise<ReservedDelivery[]> {
    const channels = await this.channels.planChannels(userId);
    const entries = planDelivery({
      category: meta.category,
      priority: meta.priority,
      enabledKinds: this.registry.enabledKinds(),
      channels,
      prefs: await this.prefs.planPrefs(userId),
      now: new Date(),
      excludeKinds,
    });
    const reserved: ReservedDelivery[] = [];
    for (const entry of entries) {
      const channel = channels.find((candidate) => candidate.kind === entry.kind);
      if (!channel) continue;
      const row = await this.reserve(userId, entry.kind, meta, entry.send ? 'queued' : 'skipped', entry.code);
      reserved.push({ kind: entry.kind, deliveryId: row.id, status: row.status, code: row.status === 'duplicate' ? null : entry.code, channel: channel.row, provider: channel.provider });
    }
    for (const entry of reserved) {
      if (entry.status !== 'queued' || !entry.deliveryId) continue;
      if (await this.overCap(userId, meta.category)) {
        await this.deliveries.update({ id: entry.deliveryId }, { status: 'skipped', code: 'CAPPED' });
        Object.assign(entry, { status: 'skipped', code: 'CAPPED' });
      }
    }
    return reserved;
  }

  /** Step 8: every queued delivery sent at once (none waits for another), each under its timeout; results recorded. */
  async sendReserved(userId: number, reserved: ReservedDelivery[], build: MessageBuilder): Promise<DeliveryEntry[]> {
    const timeoutMs = this.config.providerTimeoutMs();
    const results = await Promise.all(
      reserved.map(async (entry): Promise<DeliveryEntry> => {
        if (entry.status !== 'queued' || !entry.deliveryId) return { kind: entry.kind, status: entry.status, code: entry.code };
        const result = await this.sendOne(entry, build, timeoutMs);
        const code = result.ok ? null : safeCode(result.code);
        await this.deliveries.update({ id: entry.deliveryId }, { status: result.ok ? 'sent' : 'failed', code, sentAt: result.ok ? new Date() : null });
        await this.channels.recordUse(entry.channel.id, result.ok, code);
        return { kind: entry.kind, status: result.ok ? 'sent' : 'failed', code };
      }),
    );
    const failed = results.filter((entry) => entry.status === 'failed');
    if (failed.length > 0) this.logger.warn(`delivery to user ${userId}: ${failed.map((entry) => `${entry.kind}=${entry.code}`).join(', ')}`);
    return results;
  }

  /** One provider call: built, sent under an `AbortSignal`, a throw or a timeout turned into a code. */
  private async sendOne(entry: ReservedDelivery, build: MessageBuilder, timeoutMs: number): Promise<ChannelSendResult> {
    return this.call(entry.provider, toStoredChannel(entry.channel), () => build(entry.kind, entry.deliveryId as string, entry.provider), false, timeoutMs);
  }

  /** A test send (`POST /me/channels/:kind/test`): a fixed text, `ping: true`, same timeout and error capture. */
  async ping(provider: InteractionChannelProvider, channel: StoredChannel): Promise<ChannelSendResult> {
    const build = async (): Promise<RenderedMessage> => {
      const lang = await this.renderer.localeOf(channel.userId);
      const title = await this.renderer.server('interaction.server.test.title', lang);
      const body = await this.renderer.server('interaction.server.test.body', lang);
      return this.message(provider.kind, { deliveryId: randomUUID(), userId: channel.userId, locale: lang, category: 'info', type: 'interaction.test', title, body, url: null });
    };
    return this.call(provider, channel, build, true, this.config.providerTimeoutMs());
  }

  private async call(provider: InteractionChannelProvider, channel: StoredChannel, build: () => Promise<RenderedMessage>, ping: boolean, timeoutMs: number): Promise<ChannelSendResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ChannelSendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, code: 'TIMEOUT' });
      }, timeoutMs);
      timer.unref?.();
    });
    const attempt = (async (): Promise<ChannelSendResult> => {
      const message = await build();
      const result = await provider.send({ channel, ping, signal: controller.signal }, message);
      return result && typeof result.ok === 'boolean' ? result : { ok: false, code: 'ERROR' };
    })().catch((error: unknown): ChannelSendResult => ({ ok: false, code: safeCode(errorCode(error)) }));
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A rendered message after the app's render hooks, texts made safe again. */
  message(kind: string, message: RenderedMessage): RenderedMessage {
    const hooked = this.hooks.apply(kind, message);
    return { ...hooked, title: safeText(hooked.title, TITLE_MAX), body: safeText(hooked.body, BODY_MAX) };
  }

  /** INSERT of the delivery row; a unique violation is a duplicate (nothing will be sent). */
  private async reserve(userId: number, kind: string, meta: DeliveryMeta, status: DeliveryStatus, code: string | null): Promise<{ id: string | null; status: DeliveryStatus }> {
    const id = randomUUID();
    try {
      await this.deliveries.insert({ id, userId, dedupKey: meta.dedupKey.slice(0, 140), kind, category: meta.category, type: meta.type.slice(0, 64), ticketId: meta.ticketId, status, code, sentAt: status === 'sent' ? new Date() : null });
      return { id, status };
    } catch (error) {
      if (isUniqueViolation(error)) return { id: null, status: 'duplicate' };
      throw error;
    }
  }

  /** « Record then count »: the queued row is already in; over the user's (or the app's) hourly cap it is skipped. */
  private async overCap(userId: number, category: InteractionCategory): Promise<boolean> {
    const since = new Date(Date.now() - HOUR_MS);
    const ask = category === 'approval';
    const cap = ask ? this.config.number('interaction_askMaxPerUserHour', 0, 100000) : this.config.number('interaction_maxPerUserHour', 0, 100000);
    const categories = ask ? ['approval'] : ['info', 'security'];
    const mine = await this.deliveries.count({ where: { userId, kind: Not(INAPP_KIND), category: In(categories), status: In(ACTIVE_STATUSES), createdAt: MoreThan(since) } });
    if (mine > cap) return true;
    const global = this.config.number('interaction_maxExternalPerHour', 0, 10_000_000);
    if (global === 0) return false;
    return (await this.deliveries.count({ where: { kind: Not(INAPP_KIND), status: In(ACTIVE_STATUSES), createdAt: MoreThan(since) } })) > global;
  }

  async forgetUser(userId: number): Promise<void> {
    await this.deliveries.delete({ userId });
  }

  async purge(before: Date): Promise<void> {
    await this.deliveries.delete({ createdAt: LessThan(before) });
  }

  /** Validates a notice without sending it (`notifyMany` checks once for all). */
  validate(notice: UserNotice): CleanNotice {
    return validateNotice(notice);
  }
}

/** `delivered` when at least one external channel sent, otherwise `inapp_only` (the guaranteed fallback). */
export function report(userId: number, noticeId: string | null, deliveries: DeliveryEntry[]): DeliveryReport {
  const external = deliveries.some((entry) => entry.kind !== INAPP_KIND && entry.status === 'sent');
  return { userId, noticeId, outcome: external ? 'delivered' : 'inapp_only', deliveries };
}
