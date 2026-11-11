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
import { Brackets, LessThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/utils/dbErrors';
import { InteractionTelegramBotEntity } from '../../entities/InteractionTelegramBotEntity';
import { InteractionTelegramUpdateEntity } from '../../entities/InteractionTelegramUpdateEntity';
import { InteractionUserChannelEntity } from '../../entities/InteractionUserChannelEntity';
import { isInteractionError } from '../../errors/InteractionError';
import { OPERATOR_BOT_REF, userOfBotRef } from '../../pure/telegramUpdate';
import { InteractionConfig } from '../../services/InteractionConfig';
import { INTERACTION_SECRET_STORE, type InteractionSecretStore } from '../../types/ports';

/**
 * How long the webhook remembers an update it took (Telegram re-delivers a refused webhook call for hours, not days); a
 * `message` update older than this is acknowledged without being handled (a replay of captured traffic past the set).
 */
export const WEBHOOK_SEEN_RETENTION_MS = 2 * 86_400_000;

export type TelegramCounter = 'receivedCount' | 'ignoredCount' | 'rejectedCount' | 'sentCount' | 'droppedCount';
export type BotTokenResult = { token: string } | { code: 'NOT_CONFIGURED' | 'SECRET_UNREADABLE' | 'DISABLED' };

/**
 * Reception state of every bot (`interaction_telegram_bot`, extracted from AgentHub `TelegramInboundStore`) and the
 * resolution of a bot's token, decrypted for one call, never kept nor logged. A user's bot that is off, disabled by an
 * administrator, or whose account mode is not `own` gives a code, never a token (invariant 9: an admin-disabled bot is
 * not polled). The lease is a conditional UPDATE: one poller per bot across instances, no connection held.
 */
@Injectable()
export class TelegramBotStateStore {
  constructor(
    @InjectRepository(InteractionTelegramBotEntity) private readonly rows: Repository<InteractionTelegramBotEntity>,
    @InjectRepository(InteractionTelegramUpdateEntity) private readonly seen: Repository<InteractionTelegramUpdateEntity>,
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    @Inject(INTERACTION_SECRET_STORE) private readonly secrets: InteractionSecretStore,
    private readonly config: InteractionConfig,
  ) {}

  /** The token of a bot: the operator's (configuration secret) or a user's (their channel's secret, owner-checked). */
  async tokenFor(botRef: string): Promise<BotTokenResult> {
    if (botRef === OPERATOR_BOT_REF) {
      const mode = this.config.telegramMode();
      if (mode !== 'operator' && mode !== 'both') return { code: 'DISABLED' };
      const token = this.config.operatorBotToken();
      return token ? { token } : { code: 'NOT_CONFIGURED' };
    }
    const userId = userOfBotRef(botRef);
    if (userId === null) return { code: 'NOT_CONFIGURED' };
    const mode = this.config.telegramMode();
    if (mode !== 'own' && mode !== 'both') return { code: 'DISABLED' };
    const channel = await this.channels.findOne({ where: { userId, kind: 'telegram' } });
    if (!channel?.secretId || channel.config?.mode !== 'own') return { code: 'NOT_CONFIGURED' };
    if (!channel.enabled || channel.adminDisabled) return { code: 'DISABLED' };
    try {
      return { token: await this.secrets.reveal(channel.secretId, userId) };
    } catch (error) {
      return { code: isInteractionError(error, 'NOT_FOUND') ? 'NOT_CONFIGURED' : 'SECRET_UNREADABLE' };
    }
  }

  /** The row of a bot, created on first read (off). A plain INSERT: two racing first reads both read the same row. */
  async load(botRef: string): Promise<InteractionTelegramBotEntity> {
    const row = await this.rows.findOne({ where: { id: botRef } });
    if (row) return row;
    await this.rows.insert({ id: botRef, enabled: false, status: 'off', failures: 0 }).catch(() => undefined);
    return this.rows.findOneOrFail({ where: { id: botRef } });
  }

  async find(botRef: string): Promise<InteractionTelegramBotEntity | null> {
    return this.rows.findOne({ where: { id: botRef } });
  }

  async all(): Promise<InteractionTelegramBotEntity[]> {
    return this.rows.find({ order: { id: 'ASC' } });
  }

  async patch(botRef: string, patch: Partial<InteractionTelegramBotEntity>): Promise<void> {
    await this.load(botRef);
    await this.rows.update({ id: botRef }, patch);
  }

  async increment(botRef: string, counter: TelegramCounter, patch: Partial<InteractionTelegramBotEntity> = {}): Promise<void> {
    await this.rows.increment({ id: botRef }, counter, 1).catch(() => undefined);
    if (Object.keys(patch).length > 0) await this.rows.update({ id: botRef }, patch).catch(() => undefined);
  }

  /** The bots that are on (polled somewhere). */
  async enabledBots(): Promise<string[]> {
    return (await this.rows.find({ where: { enabled: true }, select: { id: true } })).map((row) => row.id);
  }

  /** A bot is gone (removed, replaced): its offset, counters and lease are forgotten. */
  async remove(botRef: string): Promise<void> {
    await this.rows.delete({ id: botRef });
  }

  /** Takes (or renews) the poll lease of a bot for `owner` until `now + ms`; false while another instance holds it, or once the bot is off. */
  async tryLease(botRef: string, owner: string, now: Date, ms: number): Promise<boolean> {
    const result = await this.rows
      .createQueryBuilder()
      .update(InteractionTelegramBotEntity)
      .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + ms) })
      .where('id = :id', { id: botRef })
      .andWhere('enabled = :on', { on: true })
      .andWhere(new Brackets((free) => free.where('lease_owner IS NULL').orWhere('lease_owner = :owner', { owner }).orWhere('lease_until IS NULL').orWhere('lease_until < :now', { now })))
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * Webhook mode (review F7, second review finding 3): claims `updateId` ONCE for `botRef`, in a SET of the updates seen
   * (`interaction_telegram_update`, primary key `(bot_ref, update_id)`): a replay or a re-delivery is refused, an older
   * update arriving after a newer one is still taken (once). An INSERT: two deliveries of one update cannot both win.
   * The claim comes BEFORE the handling: at-most-once (a crash while handling loses that update rather than handling it
   * twice; the app's message handlers are not idempotent).
   */
  async claimUpdate(botRef: string, updateId: number, now: Date = new Date()): Promise<boolean> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
    try {
      await this.seen.insert({ botRef, updateId: String(updateId), seenAt: now });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
    await this.rows.update({ id: botRef }, { lastUpdateAt: now }).catch(() => undefined);
    return true;
  }

  /** Seen updates older than the retention (daily purge). */
  async purgeSeenUpdates(before: Date): Promise<void> {
    await this.seen.delete({ seenAt: LessThan(before) });
  }

  async releaseLease(botRef: string, owner: string): Promise<void> {
    await this.rows.update({ id: botRef, leaseOwner: owner }, { leaseOwner: null, leaseUntil: null }).catch(() => undefined);
  }
}
