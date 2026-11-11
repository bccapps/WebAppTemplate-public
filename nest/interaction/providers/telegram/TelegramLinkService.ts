/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Linking a Telegram account to a user (04 §9, human review required; extracted from AgentHub `TelegramLinkService`).
// The user asks for a code (32 random bytes, shown once, only its SHA-256 stored, 10 minutes, single use), opens
// `t.me/<bot>?start=<code>`, Telegram delivers `/start <code>` to THAT bot, whose poll hands it to `consume`: a
// conditional UPDATE consumes the code (two deliveries cannot both win), then the link is written, unless the Telegram
// account is already linked to ANOTHER user of the app (`conflict`). Possession of the Telegram account (it sent the
// code) is the proof. Same flow for a user's own bot (`u<userId>`, 5 accounts per bot) and for the operator's bot
// (`telegram`, 5 accounts per user). Nothing here logs a code, a chat id or a Telegram id.

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/utils/dbErrors';
import { InteractionLinkCodeEntity, type TelegramLinkOutcome } from '../../entities/InteractionLinkCodeEntity';
import { InteractionTelegramLinkEntity } from '../../entities/InteractionTelegramLinkEntity';
import { InteractionError } from '../../errors/InteractionError';
import { hashCode, newLinkCode, timeOrderedId } from '../../pure/codes';
import { OPERATOR_BOT_REF, userOfBotRef, type StartCommand } from '../../pure/telegramUpdate';
import { InteractionConfig } from '../../services/InteractionConfig';
import { InteractionSignals } from '../../services/InteractionRuntime';

/** Accounts linked to one user's own bot; accounts of one user on the operator's bot. */
export const MAX_LINKS = 5;
/** Unused, unexpired codes kept per (bot, user): one more drops the oldest. */
const MAX_PENDING_CODES = 5;

export type LinkAttempt = TelegramLinkOutcome | 'invalid';

@Injectable()
export class TelegramLinkService {
  constructor(
    @InjectRepository(InteractionTelegramLinkEntity) private readonly links: Repository<InteractionTelegramLinkEntity>,
    @InjectRepository(InteractionLinkCodeEntity) private readonly codes: Repository<InteractionLinkCodeEntity>,
    private readonly config: InteractionConfig,
    private readonly signals: InteractionSignals,
  ) {}

  /**
   * A new code for `userId` on `botRef`; the code itself is returned once, never stored. Pending codes are kept per
   * (bot, user): on the shared operator's bot, one user can never push another user's codes out. « Record, then trim »
   * (safe under parallel calls): the code is inserted with a time-ordered id (`timeOrderedId`), then only the newest
   * `MAX_PENDING_CODES` pending codes of (bot, user) are kept (by id; the oldest fall); a call whose own code is not among
   * them by then gets `RATE_LIMITED { cap: 'pending' }` instead of a code that no longer exists.
   */
  async issueCode(botRef: string, userId: number): Promise<{ code: string; expiresAt: Date }> {
    const now = new Date();
    await this.codes.delete({ expiresAt: LessThan(now) });
    const code = newLinkCode();
    const id = timeOrderedId();
    const expiresAt = new Date(now.getTime() + this.config.number('interaction_linkCodeTtlMinutes', 1, 60) * 60_000);
    await this.codes.insert({ id, botRef, userId, codeHash: hashCode(code), expiresAt, usedAt: null, outcome: null });
    const pending = await this.codes.find({ where: { botRef, userId, usedAt: IsNull() }, order: { id: 'DESC' }, select: { id: true } });
    const fallen = pending.slice(MAX_PENDING_CODES).map((row) => row.id);
    if (fallen.length > 0) await this.codes.delete({ id: In(fallen), usedAt: IsNull() });
    if (fallen.includes(id) || !pending.some((row) => row.id === id)) throw new InteractionError('RATE_LIMITED', { cap: 'pending' }, 60);
    return { code, expiresAt };
  }

  /** A `/start <code>` received by `botRef`: consumes the code (once), then links the sender to the code's user, or says why not. */
  async consume(botRef: string, start: StartCommand): Promise<LinkAttempt> {
    const now = new Date();
    const codeHash = hashCode(start.code);
    const claimed = await this.codes
      .createQueryBuilder()
      .update(InteractionLinkCodeEntity)
      .set({ usedAt: now })
      .where('code_hash = :codeHash', { codeHash })
      .andWhere('bot_ref = :botRef', { botRef })
      .andWhere('used_at IS NULL')
      .andWhere('expires_at > :now', { now })
      .execute();
    if ((claimed.affected ?? 0) === 0) return 'invalid';
    const code = await this.codes.findOne({ where: { codeHash } });
    if (!code || code.userId === null) return 'invalid';
    const outcome = await this.linkOnce(botRef, code.userId, start);
    await this.codes.update({ id: code.id }, { outcome });
    if (outcome === 'linked') await this.signals.telegramLinked(code.userId, botRef);
    await this.signals.channelsChanged(code.userId, 'telegram');
    return outcome;
  }

  /**
   * The code's user gets the sender, unless the account is someone else's, already there, or the limit is reached.
   * Both checks are made again AFTER the write (« record, then count », review F8): two users racing for one account
   * both lose rather than share it, and parallel links never leave more than `MAX_LINKS` (an excess one withdraws
   * itself: `limit`; at the edge both may be refused, never both kept).
   */
  private async linkOnce(botRef: string, userId: number, start: StartCommand): Promise<TelegramLinkOutcome> {
    const owner = userOfBotRef(botRef);
    if (owner !== null && owner !== userId) return 'conflict';
    const existing = await this.links.find({ where: { telegramUserId: start.telegramUserId } });
    if (existing.some((row) => (row.userId ?? null) !== userId)) return 'conflict';
    if (existing.some((row) => row.botRef === botRef)) return 'already_linked';
    const scope = botRef === OPERATOR_BOT_REF ? { botRef, userId } : { botRef };
    if ((await this.links.count({ where: scope })) >= MAX_LINKS) return 'limit';
    const id = randomUUID();
    try {
      await this.links.insert({ id, botRef, userId, telegramUserId: start.telegramUserId, chatId: start.chatId, label: start.label, source: 'code' });
    } catch (error) {
      if (isUniqueViolation(error)) return 'already_linked';
      throw error;
    }
    const after = await this.links.find({ where: { telegramUserId: start.telegramUserId } });
    const outcome: TelegramLinkOutcome | null = after.some((row) => (row.userId ?? null) !== userId) ? 'conflict' : (await this.links.count({ where: scope })) > MAX_LINKS ? 'limit' : null;
    if (outcome === null) return 'linked';
    await this.links.delete({ id });
    return outcome;
  }

  /** The links of a user on a bot (oldest first). */
  async linksOf(botRef: string, userId: number): Promise<InteractionTelegramLinkEntity[]> {
    return this.links.find({ where: { botRef, userId }, order: { createdAt: 'ASC' } });
  }

  async countByBot(botRef: string): Promise<number> {
    return this.links.count({ where: { botRef } });
  }

  /**
   * True only for a link proven by a code that still exists on that bot for that account AND names that user: the one
   * condition under which a press may answer a question (04 §6, §8.3).
   */
  async isCodeLink(botRef: string, telegramUserId: string, userId: number): Promise<boolean> {
    const row = await this.links.findOne({ where: { botRef, telegramUserId } });
    return row !== null && row.source === 'code' && row.userId === userId;
  }

  /** Is the sender linked to someone on this bot (messages of unknown senders are ignored without an answer)? */
  async linkOfSender(botRef: string, telegramUserId: string): Promise<InteractionTelegramLinkEntity | null> {
    return this.links.findOne({ where: { botRef, telegramUserId } });
  }

  /** Removes one link of the user (owner's route only; another user's link is `NOT_FOUND`). */
  async unlink(userId: number, linkId: string): Promise<void> {
    const row = /^[0-9a-f-]{36}$/i.test(linkId) ? await this.links.findOne({ where: { id: linkId, userId } }) : null;
    if (!row) throw new InteractionError('NOT_FOUND');
    await this.links.delete({ id: row.id });
    await this.signals.channelsChanged(userId, 'telegram');
  }

  /** Every link and code of a bot (the user's bot was removed or replaced). */
  async unlinkBot(botRef: string): Promise<void> {
    await this.links.delete({ botRef });
    await this.codes.delete({ botRef });
  }

  /** The links and codes of a user on one bot (leaving the operator's bot). */
  async unlinkUserOn(botRef: string, userId: number): Promise<void> {
    await this.links.delete({ botRef, userId });
    await this.codes.delete({ botRef, userId });
  }

  async forgetUser(userId: number): Promise<void> {
    await this.links.delete({ userId });
    await this.codes.delete({ userId });
  }

  async purgeCodes(before: Date): Promise<void> {
    await this.codes.delete({ expiresAt: LessThan(before) });
  }
}
