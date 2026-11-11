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
import { In, Repository, type QueryDeepPartialEntity } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/dbErrors';
import type { ChannelTestResultDto } from '../dtos/ChannelTestResultDto';
import type { InteractionChannelAdminDto } from '../dtos/InteractionChannelAdminDto';
import type { InteractionChannelDto } from '../dtos/InteractionChannelDto';
import type { InteractionChannelSaveDto } from '../dtos/InteractionChannelSaveDto';
import { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { InteractionError } from '../errors/InteractionError';
import { iso, toStoredChannel } from '../mappers/InteractionMapper';
import { parseChannelState, parseVerifyBody } from '../pure/bodies';
import { compareChannels, type PlanChannel } from '../pure/deliveryPlan';
import { INTERACTION_AUDIT, INTERACTION_DIRECTORY, INTERACTION_REALTIME, INTERACTION_SECRET_STORE } from '../types/ports';
import type { InteractionAuditSink, InteractionDirectory, InteractionRealtimePort, InteractionSecretStore } from '../types/ports';
import type { ChannelOwner, ChannelReadiness, InteractionChannelProvider, StoredChannel } from '../types/providerTypes';
import { INAPP_CAPABILITIES, INAPP_KIND, INAPP_PROOF, InteractionProviderRegistry } from './InteractionProviderRegistry';
import { errorCode, InteractionSignals } from './InteractionRuntime';
import { InteractionSendQuotaService } from './InteractionSendQuotaService';

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A code of 04 §12.3 or `ERROR`: never a free message in a row or a log. */
export function safeCode(code: unknown): string {
  return typeof code === 'string' && CODE.test(code) ? code : 'ERROR';
}

/**
 * The users' channels (04 §5, §11): configuration through the providers, owner switch and order, removal, test sends,
 * administrators' view and switch (`admin_disabled`, journaled without target). The owner can neither re-enable nor
 * remove a channel an administrator disabled (invariant 9).
 */
@Injectable()
export class InteractionChannelService {
  private readonly logger = new Logger('InteractionChannels');

  constructor(
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    private readonly registry: InteractionProviderRegistry,
    private readonly quota: InteractionSendQuotaService,
    private readonly signals: InteractionSignals,
    @Inject(INTERACTION_SECRET_STORE) private readonly secrets: InteractionSecretStore,
    @Inject(INTERACTION_AUDIT) private readonly audit: InteractionAuditSink,
    @Inject(INTERACTION_REALTIME) private readonly realtime: InteractionRealtimePort,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
  ) {}

  /** A provider of an offered kind, or `NOT_FOUND` (unknown) / `KIND_DISABLED` (not offered now). */
  private providerFor(kind: string): InteractionChannelProvider {
    const provider = this.registry.get(kind);
    if (!provider) throw new InteractionError('NOT_FOUND');
    if (!this.registry.enabledKinds().includes(kind)) throw new InteractionError('KIND_DISABLED');
    return provider;
  }

  async rowOf(userId: number, kind: string): Promise<InteractionUserChannelEntity | null> {
    return this.channels.findOne({ where: { userId, kind } });
  }

  async readiness(provider: InteractionChannelProvider, channel: StoredChannel): Promise<ChannelReadiness> {
    try {
      if (provider.readiness) return await provider.readiness(channel);
      return (await provider.isReady(channel)) ? { ready: true, code: null } : { ready: false, code: 'NOT_CONFIGURED' };
    } catch (error) {
      return { ready: false, code: safeCode(errorCode(error)) };
    }
  }

  /** Every configured external channel of a user, with its readiness (the delivery plan's input). */
  async planChannels(userId: number): Promise<Array<PlanChannel & { row: InteractionUserChannelEntity; provider: InteractionChannelProvider }>> {
    const rows = await this.channels.find({ where: { userId } });
    const out: Array<PlanChannel & { row: InteractionUserChannelEntity; provider: InteractionChannelProvider }> = [];
    for (const row of rows) {
      const provider = this.registry.get(row.kind);
      if (!provider) continue;
      const readiness = row.enabled && !row.adminDisabled ? await this.readiness(provider, toStoredChannel(row)) : { ready: false, code: null };
      out.push({ kind: row.kind, enabled: row.enabled, adminDisabled: row.adminDisabled, position: row.position, ready: readiness.ready, notReadyCode: readiness.code, row, provider });
    }
    return out.sort(compareChannels);
  }

  /** `GET /me/channels`: `inapp` first, then every offered kind (configured or not). */
  async list(userId: number): Promise<InteractionChannelDto[]> {
    const rows = await this.channels.find({ where: { userId } });
    const out: InteractionChannelDto[] = [inappDto()];
    for (const kind of this.registry.enabledKinds()) {
      const provider = this.registry.get(kind) as InteractionChannelProvider;
      out.push(await this.toDto(provider, kind, rows.find((row) => row.kind === kind) ?? null));
    }
    return out;
  }

  async get(userId: number, kind: string): Promise<InteractionChannelDto> {
    const provider = this.providerFor(kind);
    return this.toDto(provider, kind, await this.rowOf(userId, kind));
  }

  /**
   * `PUT /me/channels/:kind`: the provider validates and builds the channel; a secret is shown at most once. What the
   * change abandons (`afterSave`: links of a previous bot…) is removed only when the write really happened.
   */
  async configure(owner: ChannelOwner, kind: string, body: unknown): Promise<InteractionChannelSaveDto> {
    const provider = this.providerFor(kind);
    const existing = await this.rowOf(owner.userId, kind);
    if (existing?.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    const result = await provider.configure(owner, body, existing ? toStoredChannel(existing) : null);
    const { row, written } = await this.persist(owner.userId, kind, existing, result.channel);
    if (written && result.afterSave) await result.afterSave().catch((error: unknown) => this.logger.warn(`after-save of ${kind} failed (${errorCode(error)})`));
    await this.changed(owner, kind, 'channel.configure');
    return { channel: await this.toDto(provider, kind, row), secret: result.secretOnce };
  }

  /** `POST /me/channels/webhook/secret` and the like: a provider able to rotate its signing secret. */
  async rotateSecret(owner: ChannelOwner, kind: string): Promise<InteractionChannelSaveDto> {
    const provider = this.providerFor(kind);
    const existing = await this.rowOf(owner.userId, kind);
    if (!existing || !provider.rotateSecret) throw new InteractionError('NOT_CONFIGURED');
    if (existing.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    const result = await provider.rotateSecret(owner, toStoredChannel(existing));
    const { row, written } = await this.persist(owner.userId, kind, existing, result.channel);
    if (written && result.afterSave) await result.afterSave().catch((error: unknown) => this.logger.warn(`after-save of ${kind} failed (${errorCode(error)})`));
    await this.changed(owner, kind, 'channel.rotate_secret');
    return { channel: await this.toDto(provider, kind, row), secret: result.secretOnce };
  }

  /**
   * Saves what a provider built (human review required; 04 §17 concurrency kit). Only the provider's columns are
   * written (`config`, `verification`, `secret_id`, `external_key`, `verified_at`), by a conditional UPDATE
   * `… WHERE admin_disabled = false AND secret_id = <the secret this write replaces>`:
   * - an administrator's switch made while the provider worked (a `getMe` call) is never overwritten by a stale row: the
   *   owner gets `ADMIN_DISABLED` and the secret the provider has just stored is destroyed;
   * - the secret replaced is known exactly (compare-and-swap on `secret_id`) and destroyed; when another write of the
   *   same channel changed the row meanwhile, this one YIELDS to it (the secret its provider stored is destroyed, the
   *   current channel returned): two racing writes of one owner leave one consistent row and no orphan secret.
   * A first configuration is an INSERT; a concurrent first one (unique `(user_id, kind)`) is re-read and this result
   * applied onto it the same way (never a raw unique violation). The provider's uniqueness key is unique per kind
   * (`UQ_ix_user_channel_kind_key`, review F5): another user's row holding it makes this write `BOT_IN_USE`, even when
   * both registered at the same instant (the provider's own check is only the early, friendly answer).
   * `written`: this write is the one now stored (false when it yielded to a concurrent one).
   */
  private async persist(userId: number, kind: string, existing: InteractionUserChannelEntity | null, channel: StoredChannel): Promise<{ row: InteractionUserChannelEntity; written: boolean }> {
    const fields = { config: { ...channel.config }, verification: channel.verification, secretId: channel.secretId, externalKey: channel.externalKey, verifiedAt: channel.verifiedAt } as QueryDeepPartialEntity<InteractionUserChannelEntity>;
    let target = existing;
    if (!target) {
      const id = randomUUID();
      try {
        await this.channels.insert({ id, userId, kind, enabled: channel.enabled !== false, adminDisabled: false, position: 0, ...fields });
        return { row: await this.channels.findOneByOrFail({ id }), written: true };
      } catch (error) {
        target = isUniqueViolation(error) ? await this.rowOf(userId, kind) : null;
        if (!target) {
          await this.dropUnkept(channel.secretId, null);
          throw isUniqueViolation(error) ? new InteractionError('BOT_IN_USE') : error;
        }
      }
    }
    const replaced = target.secretId;
    const query = this.channels.createQueryBuilder().update(InteractionUserChannelEntity).set(fields).where('id = :id', { id: target.id }).andWhere('admin_disabled = :off', { off: false });
    if (replaced === null) query.andWhere('secret_id IS NULL');
    else query.andWhere('secret_id = :replaced', { replaced });
    let affected: number;
    try {
      affected = (await query.execute()).affected ?? 0;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await this.dropUnkept(channel.secretId, replaced);
      throw new InteractionError('BOT_IN_USE');
    }
    if (affected > 0) {
      if (replaced && replaced !== channel.secretId) await this.secrets.remove(replaced).catch(() => undefined);
      return { row: await this.channels.findOneByOrFail({ id: target.id }), written: true };
    }
    const current = await this.channels.findOne({ where: { id: target.id } });
    await this.dropUnkept(channel.secretId, current?.secretId ?? null);
    if (!current || current.adminDisabled) throw new InteractionError(current ? 'ADMIN_DISABLED' : 'NOT_FOUND');
    return { row: current, written: false };
  }

  /** A secret a provider stored for a write that did not happen (it is not the row's current one). */
  private async dropUnkept(secretId: string | null, kept: string | null): Promise<void> {
    if (secretId && secretId !== kept) await this.secrets.remove(secretId).catch(() => undefined);
  }

  /**
   * `PATCH /me/channels/:kind`: `{ enabled?, position? }`; re-enabling a channel an admin disabled is `ADMIN_DISABLED`.
   * Only these columns are written (never `admin_disabled`), and re-enabling is conditional on `admin_disabled = false`.
   */
  async setState(owner: ChannelOwner, kind: string, body: unknown): Promise<InteractionChannelDto> {
    const patch = parseChannelState(body);
    const provider = this.providerFor(kind);
    const row = await this.rowOf(owner.userId, kind);
    if (!row) throw new InteractionError('NOT_CONFIGURED');
    if (patch.enabled === true && row.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    const query = this.channels.createQueryBuilder().update(InteractionUserChannelEntity).set(patch).where('id = :id', { id: row.id });
    if (patch.enabled === true) query.andWhere('admin_disabled = :off', { off: false });
    if (((await query.execute()).affected ?? 0) === 0) throw new InteractionError((await this.rowOf(owner.userId, kind))?.adminDisabled ? 'ADMIN_DISABLED' : 'NOT_CONFIGURED');
    await this.changed(owner, kind, 'channel.state');
    return this.toDto(provider, kind, await this.rowOf(owner.userId, kind));
  }

  /**
   * `DELETE /me/channels/:kind`: row and secret destroyed, bot stopped, subscriptions removed; refused when admin-disabled.
   * The row goes first, by a DELETE conditional on `admin_disabled = false` (an administrator's switch made meanwhile
   * wins), and only then the provider's state.
   */
  async remove(owner: ChannelOwner, kind: string): Promise<void> {
    const provider = this.registry.get(kind);
    if (!provider) throw new InteractionError('NOT_FOUND');
    const row = await this.rowOf(owner.userId, kind);
    if (!row) throw new InteractionError('NOT_FOUND');
    if (row.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    if (((await this.channels.delete({ id: row.id, adminDisabled: false })).affected ?? 0) === 0) throw new InteractionError((await this.rowOf(owner.userId, kind))?.adminDisabled ? 'ADMIN_DISABLED' : 'NOT_FOUND');
    await provider.onRemove?.(toStoredChannel(row));
    if (row.secretId) await this.secrets.remove(row.secretId).catch(() => undefined);
    await this.changed(owner, kind, 'channel.remove');
  }

  private async destroy(provider: InteractionChannelProvider, row: InteractionUserChannelEntity): Promise<void> {
    await provider.onRemove?.(toStoredChannel(row));
    await this.channels.delete({ id: row.id });
    if (row.secretId) await this.secrets.remove(row.secretId).catch(() => undefined);
  }

  /** `POST /me/channels/:kind/verify`. */
  async verify(owner: ChannelOwner, kind: string, body: unknown): Promise<InteractionChannelDto> {
    const code = parseVerifyBody(body);
    const provider = this.providerFor(kind);
    const row = await this.rowOf(owner.userId, kind);
    if (!row) throw new InteractionError('NOT_CONFIGURED');
    if (!provider.requiresVerification) throw new InteractionError('VERIFICATION_FAILED', { reason: 'NO_PENDING' });
    const channel = await provider.verify(owner, toStoredChannel(row), { code });
    const { row: saved } = await this.persist(owner.userId, kind, row, channel);
    await this.changed(owner, kind, 'channel.verify');
    return this.toDto(provider, kind, saved);
  }

  /** `POST /me/channels/:kind/test`: capped (`channel_test`), sent now, the result kept on the row (codes only). */
  async test(owner: ChannelOwner, kind: string, send: (provider: InteractionChannelProvider, channel: StoredChannel) => Promise<{ ok: boolean; code: string | null }>): Promise<ChannelTestResultDto> {
    const provider = this.providerFor(kind);
    const row = await this.rowOf(owner.userId, kind);
    if (!row) throw new InteractionError('NOT_CONFIGURED');
    if (row.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    await this.quota.take('channel_test', { userId: owner.userId, ip: owner.ip });
    const result = await send(provider, toStoredChannel(row));
    const code = result.ok ? null : safeCode(result.code);
    await this.channels.update({ id: row.id }, { lastTestAt: new Date(), lastTestStatus: result.ok ? 'ok' : 'failed', lastTestError: code });
    await this.record(owner, kind, 'channel.test');
    return { ok: result.ok, code };
  }

  /** Result of a delivery on the channel row: `last_used_at` (error cleared) or `last_error` (a code). */
  async recordUse(channelId: string, ok: boolean, code: string | null): Promise<void> {
    await this.channels.update({ id: channelId }, ok ? { lastUsedAt: new Date(), lastError: null } : { lastError: safeCode(code) }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Administrators
  // ---------------------------------------------------------------------------

  /** `GET /admin/interaction/channels`: metadata only (no `config`, no `view`). */
  async adminList(filter: { userId?: number; kind?: string }): Promise<InteractionChannelAdminDto[]> {
    const rows = await this.channels.find({ where: { ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.kind ? { kind: filter.kind } : {}) }, order: { createdAt: 'ASC' }, take: 500 });
    const names = rows.length > 0 ? await this.directory.displayNames([...new Set(rows.map((row) => row.userId))]).catch(() => new Map<number, string>()) : new Map<number, string>();
    const out: InteractionChannelAdminDto[] = [];
    for (const row of rows) {
      const provider = this.registry.get(row.kind);
      const meta = provider ? await provider.adminView(toStoredChannel(row)).catch(() => ({})) : {};
      out.push({
        id: row.id,
        owner: { userId: row.userId, name: names.get(row.userId) ?? null },
        kind: row.kind,
        enabled: row.enabled,
        adminDisabled: row.adminDisabled,
        configured: Object.keys(row.config ?? {}).length > 0 || row.secretId !== null,
        verified: row.verifiedAt !== null,
        meta,
        ...(row.kind === 'telegram' ? { telegram: meta } : {}),
        ...(row.kind === 'browser' ? { browser: meta } : {}),
        lastTestAt: iso(row.lastTestAt),
        lastTestStatus: row.lastTestStatus,
        lastUsedAt: iso(row.lastUsedAt),
        lastError: row.lastError,
        createdAt: iso(row.createdAt) as string,
        updatedAt: iso(row.updatedAt) as string,
      });
    }
    return out;
  }

  /**
   * `PATCH /admin/interaction/users/:userId/channels/:kind`: creates the row when absent (the kind becomes unavailable).
   * A concurrent first insert is re-read; the switch itself is one UPDATE of its three columns (parallel calls: no raw
   * unique violation, the last one wins); a row the owner removed in between is created again, so the switch holds.
   */
  async adminSetDisabled(actor: { userId: number | null }, userId: number, kind: string, disabled: boolean): Promise<void> {
    if (!this.registry.get(kind)) throw new InteractionError('NOT_FOUND');
    const patch = { adminDisabled: disabled, adminDisabledBy: disabled ? actor.userId : null, adminDisabledAt: disabled ? new Date() : null };
    let switched = false;
    for (let attempt = 0; attempt < 3 && !switched; attempt += 1) switched = ((await this.channels.update({ id: (await this.ensureRow(userId, kind)).id }, patch)).affected ?? 0) > 0;
    if (!switched) throw new InteractionError('UPSTREAM_UNAVAILABLE');
    await this.audit.record({ action: disabled ? 'channel.admin_disable' : 'channel.admin_enable', actor: { userId: actor.userId, admin: true }, ownerUserId: userId, kind, at: new Date() });
    this.realtime.publish(userId, { type: 'channels.changed', data: { kind } });
    await this.signals.channelsChanged(userId, kind);
  }

  /** The row of (user, kind), created empty and off when absent (a lost first-insert race reads the winner's). */
  private async ensureRow(userId: number, kind: string): Promise<InteractionUserChannelEntity> {
    const existing = await this.rowOf(userId, kind);
    if (existing) return existing;
    try {
      await this.channels.insert({ userId, kind, enabled: false, adminDisabled: false, position: 0, config: {}, verification: null, secretId: null, externalKey: null, verifiedAt: null });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.channels.findOneOrFail({ where: { userId, kind } });
  }

  /** Account deletion: every channel, its secret and its provider state. */
  async forgetUser(userId: number): Promise<void> {
    for (const row of await this.channels.find({ where: { userId } })) {
      const provider = this.registry.get(row.kind);
      if (provider) await this.destroy(provider, row).catch((error: unknown) => this.logger.warn(`forget channel failed (${errorCode(error)})`));
      else await this.channels.delete({ id: row.id });
      await this.signals.channelsChanged(userId, row.kind);
    }
  }

  /** The ids of the rows of a kind among users (fleet reconciliation). */
  async rowsOfKind(kind: string, userIds?: number[]): Promise<InteractionUserChannelEntity[]> {
    return this.channels.find({ where: { kind, ...(userIds ? { userId: In(userIds) } : {}) }, order: { createdAt: 'ASC' } });
  }

  private async changed(owner: ChannelOwner, kind: string, action: string): Promise<void> {
    await this.record(owner, kind, action);
    this.realtime.publish(owner.userId, { type: 'channels.changed', data: { kind } });
    await this.signals.channelsChanged(owner.userId, kind);
  }

  private async record(owner: ChannelOwner, kind: string, action: string): Promise<void> {
    await this.audit.record({ action, actor: { userId: owner.userId, admin: false }, ownerUserId: owner.userId, kind, at: new Date() }).catch(() => undefined);
  }

  private async toDto(provider: InteractionChannelProvider, kind: string, row: InteractionUserChannelEntity | null): Promise<InteractionChannelDto> {
    const stored = row ? toStoredChannel(row) : null;
    const readiness = stored && row && row.enabled && !row.adminDisabled ? await this.readiness(provider, stored) : { ready: false, code: null };
    return {
      kind,
      id: row?.id ?? null,
      enabled: row?.enabled ?? false,
      adminDisabled: row?.adminDisabled ?? false,
      configured: row !== null && (Object.keys(row.config ?? {}).length > 0 || row.secretId !== null),
      verified: row?.verifiedAt != null,
      ready: readiness.ready,
      position: row?.position ?? 0,
      capabilities: [...provider.capabilities],
      proof: provider.proof,
      view: stored ? await provider.ownerView(stored).catch(() => ({})) : {},
      lastTestAt: iso(row?.lastTestAt),
      lastTestStatus: row?.lastTestStatus ?? null,
      lastTestError: row?.lastTestError ?? null,
      lastUsedAt: iso(row?.lastUsedAt),
      lastError: row?.lastError ?? null,
      updatedAt: iso(row?.updatedAt),
    };
  }
}

function inappDto(): InteractionChannelDto {
  return {
    kind: INAPP_KIND,
    id: null,
    enabled: true,
    adminDisabled: false,
    configured: true,
    verified: true,
    ready: true,
    position: -1,
    capabilities: [...INAPP_CAPABILITIES],
    proof: INAPP_PROOF,
    view: {},
    lastTestAt: null,
    lastTestStatus: null,
    lastTestError: null,
    lastUsedAt: null,
    lastError: null,
    updatedAt: null,
  };
}
