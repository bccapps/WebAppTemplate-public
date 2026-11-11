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
import { Repository } from 'typeorm';
import type { InteractionTelegramLinkEntity } from '../../entities/InteractionTelegramLinkEntity';
import { InteractionUserChannelEntity } from '../../entities/InteractionUserChannelEntity';
import { isInteractionError } from '../../errors/InteractionError';
import { normalizeLang } from '../../services/InteractionRenderer';
import { parseCallback, pressMatchesBinding, verifyCallback, CALLBACK_PREFIX } from '../../pure/telegramCallback';
import { messageOf, OPERATOR_BOT_REF, pressOf, startCommandOf, userOfBotRef, type StartCommand, type TelegramMessage, type TelegramPress } from '../../pure/telegramUpdate';
import { InteractionConfig } from '../../services/InteractionConfig';
import { InteractionKeyService } from '../../services/InteractionKeyService';
import { InteractionRenderer } from '../../services/InteractionRenderer';
import { errorCode } from '../../services/InteractionRuntime';
import { InteractionTicketCardStore } from '../../services/InteractionTicketCardStore';
import { InteractionTicketService } from '../../services/InteractionTicketService';
import { INTERACTION_DIRECTORY, type InteractionDirectory } from '../../types/ports';
import { TelegramBotClient } from './TelegramBotClient';
import { TelegramBotStateStore } from './TelegramBotStateStore';
import { TelegramInboundRegistry, type TelegramInboundContext } from './TelegramInboundRegistry';
import { TelegramLinkService } from './TelegramLinkService';
import { TelegramSender } from './TelegramSender';

const HOUR_MS = 3_600_000;

interface PressVerdict {
  text: string;
  ok: boolean;
  reason: string;
}

/**
 * One update of a bot, whatever brought it (long polling or the webhook route). Human review required on `cardPress`:
 * a press of a question card is accepted only when ALL hold (04 §8.3): signature valid (checked before any database
 * access), open card found by its key, bound to this bot, this chat, this message and this Telegram account, a `code`
 * link still naming the card's user, that user active; then the ticket rules (§8.2). Otherwise one generic answer
 * (« this button is no longer active »), nothing learned, nothing changed. `answerCallbackQuery` is always called.
 */
@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger('TelegramInbound');
  private readonly startReplies = new Map<string, number[]>();

  constructor(
    private readonly client: TelegramBotClient,
    private readonly sender: TelegramSender,
    private readonly state: TelegramBotStateStore,
    private readonly links: TelegramLinkService,
    private readonly cards: InteractionTicketCardStore,
    private readonly tickets: InteractionTicketService,
    private readonly keys: InteractionKeyService,
    private readonly renderer: InteractionRenderer,
    private readonly config: InteractionConfig,
    private readonly registry: TelegramInboundRegistry,
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
  ) {}

  /** Never throws: a failing update is counted and logged by code. */
  async handle(botRef: string, token: string, update: unknown): Promise<void> {
    try {
      const press = pressOf(update);
      if (press) return await this.onPress(botRef, token, press);
      const start = startCommandOf(update);
      if (start) return await this.onStart(botRef, token, start);
      const message = messageOf(update);
      if (message) return await this.onMessage(botRef, token, message);
      await this.state.increment(botRef, 'ignoredCount');
    } catch (error) {
      this.logger.warn(`update of a bot not handled (${errorCode(error)})`);
      await this.state.increment(botRef, 'rejectedCount', { lastRejection: 'ERROR' });
    }
  }

  private async onPress(botRef: string, token: string, judged: NonNullable<ReturnType<typeof pressOf>>): Promise<void> {
    if ('ignore' in judged) {
      if (judged.callbackId) await this.client.answerCallbackQuery(token, judged.callbackId, await this.generic(null));
      return this.state.increment(botRef, 'ignoredCount');
    }
    const { press } = judged;
    if (press.data.startsWith(CALLBACK_PREFIX)) {
      const verdict = await this.cardPress(botRef, press);
      await this.client.answerCallbackQuery(token, press.callbackId, verdict.text);
      if (verdict.ok) return this.state.increment(botRef, 'receivedCount', { lastMessageAt: new Date() });
      return this.state.increment(botRef, 'rejectedCount', { lastRejection: verdict.reason });
    }
    const family = this.registry.familyFor(press.data);
    const link = family ? await this.servingLink(botRef, press.telegramUserId) : null;
    if (!family || !link) {
      await this.client.answerCallbackQuery(token, press.callbackId, await this.generic(press.languageCode));
      return this.state.increment(botRef, 'ignoredCount');
    }
    const text = await family(press, this.context(botRef, token, press.chatId, link.userId)).catch(() => null);
    await this.client.answerCallbackQuery(token, press.callbackId, text);
    await this.state.increment(botRef, 'receivedCount', { lastMessageAt: new Date() });
  }

  /** The press of a question card (human review required). */
  async cardPress(botRef: string, press: TelegramPress): Promise<PressVerdict> {
    const generic = await this.generic(press.languageCode);
    const callback = parseCallback(press.data);
    if (!callback || !verifyCallback(this.keys.callbackKey(), botRef, callback)) return { text: generic, ok: false, reason: 'BAD_SIGNATURE' };
    const card = await this.cards.findOpenByKey(callback.cardKey);
    if (!card || card.kind !== 'telegram') return { text: generic, ok: false, reason: 'UNKNOWN_CARD' };
    const bound = pressMatchesBinding(card.binding, { botRef, chatId: press.chatId, telegramUserId: press.telegramUserId, messageId: press.messageId });
    if (!bound) return { text: generic, ok: false, reason: 'NOT_BOUND' };
    if (!(await this.links.isCodeLink(botRef, press.telegramUserId, card.userId))) return { text: generic, ok: false, reason: 'NOT_LINKED' };
    // Review F2: the owner's and the administrator's switches stop the answers of cards already sent, in both modes.
    if (!(await this.channelServes(botRef, card.userId))) return { text: generic, ok: false, reason: 'CHANNEL_OFF' };
    if (!(await this.directory.isActive(card.userId))) return { text: generic, ok: false, reason: 'INACTIVE' };
    const lang = card.lang;
    try {
      await this.tickets.answer({ ticketId: card.ticketId, userId: card.userId, via: 'telegram', actionIndex: callback.index });
      return { text: await this.renderer.server('interaction.server.telegram.press.recorded', lang), ok: true, reason: 'ANSWERED' };
    } catch (error) {
      // Told to the linked account only (its binding was verified above).
      if (isInteractionError(error, 'ALREADY_ANSWERED')) return { text: await this.renderer.server('interaction.server.telegram.press.alreadyAnswered', lang), ok: false, reason: 'ALREADY_ANSWERED' };
      if (isInteractionError(error, 'EXPIRED')) return { text: await this.renderer.server('interaction.server.telegram.press.expired', lang), ok: false, reason: 'EXPIRED' };
      if (isInteractionError(error, 'CANCELLED')) return { text: await this.renderer.server('interaction.server.telegram.press.cancelled', lang), ok: false, reason: 'CANCELLED' };
      return { text: generic, ok: false, reason: errorCode(error) };
    }
  }

  private async generic(languageCode: string | null): Promise<string> {
    return this.renderer.server('interaction.server.telegram.press.inactive', normalizeLang(languageCode) ?? this.renderer.defaultLocale());
  }

  /** `/start <code>`: linked (or why not), answered under the per-bot hourly cap. */
  private async onStart(botRef: string, token: string, start: StartCommand): Promise<void> {
    const outcome = await this.links.consume(botRef, start).catch(() => 'invalid' as const);
    await this.state.increment(botRef, outcome === 'linked' ? 'receivedCount' : 'ignoredCount');
    if (!this.underStartReplyCap(botRef)) return;
    const lang = normalizeLang(start.languageCode) ?? this.renderer.defaultLocale();
    await this.sender.send(botRef, token, start.chatId, await this.renderer.server(`interaction.server.telegram.link.${outcome}`, lang)).catch(() => undefined);
  }

  /**
   * A message of a linked sender goes to the app's handlers (commands, voice, text) when `servingLink` admits it and the
   * reception switch of a user's own bot is on; anything else is ignored silently.
   */
  private async onMessage(botRef: string, token: string, message: TelegramMessage): Promise<void> {
    const link = await this.servingLink(botRef, message.telegramUserId);
    if (!link || !(await this.receptionOn(botRef))) return this.state.increment(botRef, 'ignoredCount');
    const handler = message.command ? this.registry.commandFor(message.command.name) : message.voice ? this.registry.voice() : this.registry.message();
    if (!handler) return this.state.increment(botRef, 'ignoredCount');
    await handler(message, this.context(botRef, token, message.chatId, link.userId));
    await this.state.increment(botRef, 'receivedCount', { lastMessageAt: new Date() });
  }

  /**
   * The sender's link when its updates may reach the app's handlers (review F2): proven by `/start <code>` (not a
   * `declared` / `legacy` link), naming a user who is active and whose Telegram channel serves THIS bot (`channelServes`).
   */
  private async servingLink(botRef: string, telegramUserId: string): Promise<InteractionTelegramLinkEntity | null> {
    const link = await this.links.linkOfSender(botRef, telegramUserId);
    if (!link || link.source !== 'code' || link.userId === null) return null;
    if (!(await this.channelServes(botRef, link.userId))) return null;
    return (await this.directory.isActive(link.userId).catch(() => false)) ? link : null;
  }

  /**
   * The user's Telegram channel is on, not disabled by an administrator, and in the mode of this bot: the operator's
   * bot for `operator`, the user's own `u<id>` for `own`.
   */
  private async channelServes(botRef: string, userId: number): Promise<boolean> {
    const row = await this.channels.findOne({ where: { userId, kind: 'telegram' } });
    if (!row || !row.enabled || row.adminDisabled) return false;
    const mode = row.config?.mode === 'operator' ? 'operator' : 'own';
    return botRef === OPERATOR_BOT_REF ? mode === 'operator' : mode === 'own' && userOfBotRef(botRef) === userId;
  }

  /** A user's own bot: the owner's reception switch (`inbound`); the operator's bot: always on. */
  private async receptionOn(botRef: string): Promise<boolean> {
    const userId = userOfBotRef(botRef);
    if (userId === null) return true;
    const row = await this.channels.findOne({ where: { userId, kind: 'telegram' } });
    return row?.config?.inbound !== false;
  }

  private context(botRef: string, token: string, chatId: string, userId: number | null): TelegramInboundContext {
    return { botRef, userId, reply: async (text) => void (await this.sender.send(botRef, token, chatId, text.slice(0, 4000))) };
  }

  private underStartReplyCap(botRef: string): boolean {
    const now = Date.now();
    const recent = (this.startReplies.get(botRef) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= this.config.number('interaction_telegramStartRepliesPerHour', 0, 1000)) {
      this.startReplies.set(botRef, recent);
      return false;
    }
    this.startReplies.set(botRef, [...recent, now]);
    return true;
  }
}
