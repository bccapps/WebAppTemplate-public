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
import { Not, Repository } from 'typeorm';
import type { TelegramLinkCodeDto } from '../../dtos/TelegramLinkCodeDto';
import { InteractionTicketEntity } from '../../entities/InteractionTicketEntity';
import { InteractionUserChannelEntity } from '../../entities/InteractionUserChannelEntity';
import type { InteractionTelegramLinkEntity } from '../../entities/InteractionTelegramLinkEntity';
import { InteractionError } from '../../errors/InteractionError';
import { parseCallback, signCallback, verifyCallback } from '../../pure/telegramCallback';
import { botIdOf, chunkForTelegram, isBotToken, OPERATOR_BOT_REF, pressOf, userBotRef } from '../../pure/telegramUpdate';
import { InteractionConfig } from '../../services/InteractionConfig';
import { InteractionKeyService } from '../../services/InteractionKeyService';
import { InteractionRenderer } from '../../services/InteractionRenderer';
import { InteractionSendQuotaService } from '../../services/InteractionSendQuotaService';
import { InteractionSignals } from '../../services/InteractionRuntime';
import { InteractionTicketCardStore } from '../../services/InteractionTicketCardStore';
import type { InteractionAnswer, InteractionCapability, InteractionProof } from '../../types/interactionTypes';
import { INTERACTION_AUDIT, INTERACTION_SECRET_STORE, type InteractionAuditSink, type InteractionSecretStore } from '../../types/ports';
import type { ChannelConfigureResult, ChannelOwner, ChannelReadiness, ChannelSendResult, InteractionChannelProvider, ParsedReply, RenderedMessage, SendContext, StoredChannel, TicketCardRef } from '../../types/providerTypes';
import { TelegramBotClient, type TelegramInlineButton, type TelegramInlineKeyboard } from './TelegramBotClient';
import { TelegramBotStateStore } from './TelegramBotStateStore';
import { TelegramInboundRegistry } from './TelegramInboundRegistry';
import { TelegramLinkService } from './TelegramLinkService';
import { TelegramSender } from './TelegramSender';

export type TelegramChannelMode = 'own' | 'operator';

/** `{ mode?, token?, inbound? }` (04 §11.4 `TelegramChannelBody`; `enabled` is the owner's switch, `PATCH`). */
export interface TelegramChannelInput {
  mode?: TelegramChannelMode;
  token?: string;
  inbound?: boolean;
}

const IDENTITY_TTL_MS = 10 * 60_000;

function invalid(field: string, reason: string): never {
  throw new InteractionError('INVALID_CONFIG', { field, reason });
}

/**
 * The Telegram channel (04 §5, §8.3, §9; human review required). Two modes per user: `own` (the user's own bot, token
 * checked with `getMe`, refused when another user or the operator uses it, kept in the secret store in the user's name,
 * NEVER returned) and `operator` (the operator's bot, configured by an administrator). Either way an account is linked
 * by `/start <code>`. Plain-text messages; a question goes as a card whose buttons carry a signed `ix:` callback for the
 * `code` links only, or as a message with a link into the app when Telegram may not answer it.
 */
@Injectable()
export class TelegramChannelProvider implements InteractionChannelProvider<TelegramChannelInput> {
  readonly kind = 'telegram';
  readonly capabilities: ReadonlySet<InteractionCapability> = new Set<InteractionCapability>(['notify', 'open', 'reply']);
  /** A button press is never a proof: a `freshProof` question gets an « open in the app » link (04 §21.4, §22). */
  readonly proof: InteractionProof = 'link';
  readonly requiresVerification = false;
  readonly configSchema = { parse: (input: unknown): TelegramChannelInput => parseTelegramInput(input), secretFields: ['token'] as const };
  private operatorIdentity: { at: number; id: string | null; username: string | null } | null = null;

  constructor(
    private readonly client: TelegramBotClient,
    private readonly sender: TelegramSender,
    private readonly links: TelegramLinkService,
    private readonly state: TelegramBotStateStore,
    private readonly cards: InteractionTicketCardStore,
    private readonly keys: InteractionKeyService,
    private readonly renderer: InteractionRenderer,
    private readonly config: InteractionConfig,
    private readonly quota: InteractionSendQuotaService,
    private readonly signals: InteractionSignals,
    private readonly registry: TelegramInboundRegistry,
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    @InjectRepository(InteractionTicketEntity) private readonly tickets: Repository<InteractionTicketEntity>,
    @Inject(INTERACTION_SECRET_STORE) private readonly secrets: InteractionSecretStore,
    @Inject(INTERACTION_AUDIT) private readonly audit: InteractionAuditSink,
  ) {}

  /** The modes the app offers now (`interaction_telegramMode`). */
  allowedModes(): TelegramChannelMode[] {
    const mode = this.config.telegramMode();
    if (mode === 'both') return ['own', 'operator'];
    return mode === 'own' || mode === 'operator' ? [mode] : [];
  }

  static botRefOf(channel: Pick<StoredChannel, 'userId' | 'config'>): string {
    return channel.config?.mode === 'operator' ? OPERATOR_BOT_REF : userBotRef(channel.userId);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  async configure(owner: ChannelOwner, input: unknown, current: StoredChannel | null): Promise<ChannelConfigureResult> {
    const body = parseTelegramInput(input);
    const allowed = this.allowedModes();
    if (allowed.length === 0) throw new InteractionError('KIND_DISABLED');
    const currentMode = current?.config?.mode === 'operator' ? 'operator' : current ? 'own' : null;
    const mode = body.mode ?? (currentMode && allowed.includes(currentMode) ? currentMode : allowed[0]);
    if (!allowed.includes(mode)) invalid('mode', 'MODE_DISABLED');
    const inbound = body.inbound ?? (current?.config?.inbound !== false);
    const base: StoredChannel = current ?? { id: '', userId: owner.userId, kind: 'telegram', enabled: true, adminDisabled: false, position: 0, config: {}, verification: null, secretId: null, externalKey: null, verifiedAt: null };
    if (mode === 'operator') return this.toOperator(owner, base, inbound, currentMode);
    return this.toOwn(owner, base, body.token, inbound, currentMode);
  }

  /** To the operator's bot: the user's own bot (links, codes, state) goes only once the channel service has written the row. */
  private async toOperator(owner: ChannelOwner, base: StoredChannel, inbound: boolean, currentMode: TelegramChannelMode | null): Promise<ChannelConfigureResult> {
    // The secret of a previous own bot is destroyed by the channel service (`secretId: null`).
    const channel: StoredChannel = { ...base, config: { mode: 'operator', inbound }, secretId: null, externalKey: null, verifiedAt: new Date() };
    return { channel, secretOnce: null, afterSave: currentMode === 'own' ? () => this.dropOwnBot(owner.userId) : undefined };
  }

  /**
   * To the user's own bot (second review, finding 1). A token always goes into a NEW secret (never rotated in place):
   * if the write is refused (`BOT_IN_USE` from the unique index, an administrator's switch, a concurrent write), the row
   * keeps its previous secret untouched and the new one is destroyed. What this change abandons (the links of the
   * operator's bot, or of the previous own bot when the bot changes) is removed only AFTER the write succeeded
   * (`afterSave`), so a refused configuration leaves the user's channel, secret and links exactly as they were.
   */
  private async toOwn(owner: ChannelOwner, base: StoredChannel, token: string | undefined, inbound: boolean, currentMode: TelegramChannelMode | null): Promise<ChannelConfigureResult> {
    if (token === undefined) {
      if (currentMode !== 'own' || !base.secretId) invalid('token', 'TELEGRAM_TOKEN_INVALID');
      return { channel: { ...base, config: { ...base.config, mode: 'own', inbound } }, secretOnce: null };
    }
    const me = await this.client.getMe(token);
    if (me.ok === false) {
      if (me.status === 401 || me.status === 404 || me.status === 400) invalid('token', 'TELEGRAM_TOKEN_INVALID');
      throw new InteractionError('UPSTREAM_UNAVAILABLE');
    }
    const botId = me.result.id;
    const taken = await this.channels.findOne({ where: { kind: 'telegram', externalKey: botId, userId: Not(owner.userId) } });
    if (taken || (await this.operatorBotId()) === botId) throw new InteractionError('BOT_IN_USE');
    const secretId = await this.secrets.put(owner.userId, 'telegram_bot_token', token);
    const channel: StoredChannel = { ...base, config: { mode: 'own', botId, botUsername: me.result.username, inbound }, secretId, externalKey: botId, verifiedAt: new Date() };
    const leavesOperator = currentMode === 'operator';
    const changesBot = currentMode === 'own' && base.externalKey !== null && base.externalKey !== botId;
    const afterSave = leavesOperator || changesBot ? () => (leavesOperator ? this.links.unlinkUserOn(OPERATOR_BOT_REF, owner.userId) : this.dropOwnBot(owner.userId)) : undefined;
    return { channel, secretOnce: null, afterSave };
  }

  /** The user's own bot goes: its links, its codes, its reception state. */
  private async dropOwnBot(userId: number): Promise<void> {
    const botRef = userBotRef(userId);
    await this.links.unlinkBot(botRef);
    await this.state.remove(botRef);
  }

  async verify(): Promise<StoredChannel> {
    throw new InteractionError('VERIFICATION_FAILED', { reason: 'NO_PENDING' });
  }

  async isReady(channel: StoredChannel): Promise<boolean> {
    return (await this.readiness(channel)).ready;
  }

  async readiness(channel: StoredChannel): Promise<ChannelReadiness> {
    const mode = channel.config?.mode === 'operator' ? 'operator' : 'own';
    if (!this.allowedModes().includes(mode)) return { ready: false, code: 'KIND_DISABLED' };
    if (mode === 'own' && (!channel.secretId || !channel.externalKey)) return { ready: false, code: 'NOT_CONFIGURED' };
    if (mode === 'operator' && !this.config.operatorBotToken()) return { ready: false, code: 'NOT_CONFIGURED' };
    const linked = await this.links.linksOf(TelegramChannelProvider.botRefOf(channel), channel.userId);
    return linked.length > 0 ? { ready: true, code: null } : { ready: false, code: 'NOT_LINKED' };
  }

  // ---------------------------------------------------------------------------
  // Linking (owner's routes)
  // ---------------------------------------------------------------------------

  /** `POST /me/channels/telegram/link-code` (capped `link_code`): a code and its deep link, shown once. */
  async linkCode(owner: ChannelOwner): Promise<TelegramLinkCodeDto> {
    const row = await this.channels.findOne({ where: { userId: owner.userId, kind: 'telegram' } });
    if (!row) throw new InteractionError('NOT_CONFIGURED');
    if (row.adminDisabled) throw new InteractionError('ADMIN_DISABLED');
    const mode = row.config?.mode === 'operator' ? 'operator' : 'own';
    if (!this.allowedModes().includes(mode)) throw new InteractionError('KIND_DISABLED');
    const username = mode === 'own' ? (typeof row.config?.botUsername === 'string' ? row.config.botUsername : null) : (await this.operator())?.username ?? null;
    if (!username || (mode === 'own' && !row.secretId)) throw new InteractionError('NOT_CONFIGURED');
    await this.quota.take('link_code', { userId: owner.userId, ip: owner.ip });
    const issued = await this.links.issueCode(mode === 'own' ? userBotRef(owner.userId) : OPERATOR_BOT_REF, owner.userId);
    await this.audit.record({ action: 'telegram.link_code', actor: { userId: owner.userId, admin: false }, ownerUserId: owner.userId, kind: 'telegram', at: new Date() }).catch(() => undefined);
    await this.signals.channelsChanged(owner.userId, 'telegram');
    return { code: issued.code, deepLink: `https://t.me/${username}?start=${issued.code}`, expiresAt: issued.expiresAt.toISOString() };
  }

  async unlink(owner: ChannelOwner, linkId: string): Promise<void> {
    await this.links.unlink(owner.userId, linkId);
    await this.audit.record({ action: 'telegram.unlink', actor: { userId: owner.userId, admin: false }, ownerUserId: owner.userId, kind: 'telegram', at: new Date() }).catch(() => undefined);
  }

  /** The operator's bot (`getMe`, cached 10 minutes): its public id and `@username`, null when not configured or unreachable. */
  async operator(): Promise<{ id: string | null; username: string | null } | null> {
    const token = this.config.operatorBotToken();
    if (!token) return null;
    if (this.operatorIdentity && Date.now() - this.operatorIdentity.at < IDENTITY_TTL_MS && this.operatorIdentity.id === botIdOf(token)) return this.operatorIdentity;
    const me = await this.client.getMe(token);
    if (me.ok === false) return { id: botIdOf(token), username: null };
    this.operatorIdentity = { at: Date.now(), id: me.result.id, username: me.result.username };
    return this.operatorIdentity;
  }

  /** `POST /admin/interaction/telegram/operator/check`. */
  async checkOperator(): Promise<{ ok: boolean; botUsername: string | null; code: string | null }> {
    const token = this.config.operatorBotToken();
    if (!token) return { ok: false, botUsername: null, code: 'NOT_CONFIGURED' };
    const me = await this.client.getMe(token);
    if (me.ok === false) return { ok: false, botUsername: null, code: me.status === 401 || me.status === 404 ? 'TELEGRAM_TOKEN_INVALID' : `TELEGRAM_${me.status}` };
    this.operatorIdentity = { at: Date.now(), id: me.result.id, username: me.result.username };
    return { ok: true, botUsername: me.result.username, code: null };
  }

  private async operatorBotId(): Promise<string | null> {
    const token = this.config.operatorBotToken();
    return token ? botIdOf(token) : null;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async send(ctx: SendContext, message: RenderedMessage): Promise<ChannelSendResult> {
    if (!ctx.channel) return { ok: false, code: 'NOT_CONFIGURED' };
    const botRef = TelegramChannelProvider.botRefOf(ctx.channel);
    const bot = await this.state.tokenFor(botRef);
    if ('code' in bot) return { ok: false, code: bot.code };
    const targets = await this.links.linksOf(botRef, ctx.channel.userId);
    if (targets.length === 0) return { ok: false, code: 'NOT_LINKED' };
    let sent = 0;
    let lastCode: string | null = null;
    for (const link of targets) {
      if (ctx.signal.aborted) return { ok: sent > 0, code: sent > 0 ? null : 'TIMEOUT' };
      const result = message.question && !ctx.ping ? await this.sendQuestion(botRef, bot.token, link, message) : await this.sendNotice(botRef, bot.token, link, message, ctx.ping);
      if (result.ok) sent += 1;
      else lastCode = result.code;
    }
    return sent > 0 ? { ok: true, code: null } : { ok: false, code: lastCode ?? 'ERROR' };
  }

  private async sendNotice(botRef: string, token: string, link: InteractionTelegramLinkEntity, message: RenderedMessage, ping: boolean): Promise<{ ok: boolean; code: string | null }> {
    const text = ping ? await this.renderer.server('interaction.server.telegram.test', message.locale) : [message.title, message.body].filter((part) => part !== '').join('\n\n');
    const url = message.question?.openUrl ?? message.url;
    const keyboard: TelegramInlineKeyboard | undefined = url && !ping ? { inline_keyboard: [[{ text: await this.renderer.server('interaction.server.telegram.open', message.locale), url }]] } : undefined;
    let first = true;
    for (const chunk of chunkForTelegram(text)) {
      const result = await this.sender.send(botRef, token, link.chatId, chunk, first ? keyboard : undefined);
      if (!result.ok) return { ok: false, code: result.code };
      if (first && link.userId !== null) this.registry.notificationSent({ botRef, userId: link.userId, chatId: link.chatId, messageId: result.messageId });
      first = false;
    }
    return { ok: true, code: null };
  }

  /**
   * A question: a card with signed buttons for a `code` link when Telegram may answer it (the card row is written
   * BEFORE the send, its message id bound after); otherwise a message with a link into the app.
   */
  private async sendQuestion(botRef: string, token: string, link: InteractionTelegramLinkEntity, message: RenderedMessage): Promise<{ ok: boolean; code: string | null }> {
    const question = message.question as NonNullable<RenderedMessage['question']>;
    if (!question.answerable || link.source !== 'code' || link.userId !== message.userId) {
      const note = await this.renderer.server('interaction.server.telegram.answerInApp', message.locale);
      return this.sendNotice(botRef, token, link, { ...message, body: [message.body, note].filter((part) => part !== '').join('\n\n') }, false);
    }
    const binding = { botRef, chatId: link.chatId, telegramUserId: link.telegramUserId, messageId: '' };
    const card = await this.cards.open({ ticketId: question.ticketId, userId: message.userId, kind: this.kind, binding, lang: message.locale });
    const key = this.keys.callbackKey();
    const rows: TelegramInlineButton[][] = question.actions.map((action) => [{ text: action.label.slice(0, 64) || action.id, callback_data: signCallback(key, botRef, card.cardKey, action.index) }]);
    if (question.openUrl) rows.push([{ text: await this.renderer.server('interaction.server.telegram.open', message.locale), url: question.openUrl }]);
    const minutes = Math.max(1, Math.round((question.expiresAt.getTime() - Date.now()) / 60_000));
    const expiry = await this.renderer.server('interaction.server.telegram.card.expires', message.locale, { minutes });
    const text = chunkForTelegram([message.title, message.body, expiry].filter((part) => part !== '').join('\n\n'), 4000, 1)[0];
    const result = await this.sender.send(botRef, token, link.chatId, text, { inline_keyboard: rows });
    if (!result.ok || !result.messageId) {
      await this.cards.close(card.id);
      return { ok: false, code: result.ok ? 'TELEGRAM_502' : result.code };
    }
    await this.cards.bind(card.id, { ...binding, messageId: result.messageId });
    this.registry.notificationSent({ botRef, userId: message.userId, chatId: link.chatId, messageId: result.messageId });
    return { ok: true, code: null };
  }

  /** Redraws a closed card: the question's title and its outcome, no buttons (« answered via … », « expired », « cancelled »). */
  async closeCard(card: TicketCardRef, outcome: InteractionAnswer): Promise<void> {
    const { botRef, chatId, messageId } = card.binding;
    if (!botRef || !chatId || !messageId) return;
    const bot = await this.state.tokenFor(botRef);
    if ('code' in bot) return;
    const ticket = await this.tickets.findOne({ where: { id: card.ticketId } });
    const title = ticket ? await this.renderer.render(ticket.summary.title, card.lang, 120) : '';
    const action = ticket?.actions.find((candidate) => candidate.id === outcome.actionId);
    const label = action ? await this.renderer.render(action.label, card.lang, 40) : '';
    const line = await this.renderer.server(`interaction.server.telegram.card.${outcome.status}`, card.lang, { action: label, via: outcome.via ?? '' });
    await this.sender.edit(botRef, bot.token, chatId, messageId, [title, line].filter((part) => part !== '').join('\n\n'));
  }

  /** A raw `{ botRef, update }` → the press, its signature already checked (before any database access). */
  async parseReply(raw: unknown): Promise<ParsedReply | null> {
    const input = raw as { botRef?: unknown; update?: unknown } | null;
    if (!input || typeof input.botRef !== 'string') return null;
    const judged = pressOf(input.update);
    if (!judged || !('press' in judged)) return null;
    const callback = parseCallback(judged.press.data);
    if (!callback) return null;
    const { press } = judged;
    return {
      kind: this.kind,
      cardKey: callback.cardKey,
      actionIndex: callback.index,
      signatureValid: verifyCallback(this.keys.callbackKey(), input.botRef, callback),
      binding: { botRef: input.botRef, chatId: press.chatId, telegramUserId: press.telegramUserId, messageId: press.messageId },
      channelUserRef: press.telegramUserId,
    };
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** The owner's view: mode, bot name, reception switch, their linked accounts (label only). Never the token. */
  async ownerView(channel: StoredChannel): Promise<Record<string, unknown>> {
    const mode = channel.config?.mode === 'operator' ? 'operator' : 'own';
    const botRef = TelegramChannelProvider.botRefOf(channel);
    const username = mode === 'own' ? channel.config?.botUsername ?? null : (await this.operator().catch(() => null))?.username ?? null;
    const linked = await this.links.linksOf(botRef, channel.userId);
    return {
      mode,
      allowedModes: this.allowedModes(),
      botUsername: username,
      tokenSet: mode === 'own' && channel.secretId !== null,
      inbound: channel.config?.inbound !== false,
      links: linked.map((link) => ({ id: link.id, label: link.label, source: link.source, createdAt: link.createdAt.toISOString() })),
    };
  }

  /** Administrators: mode, bot name, number of linked accounts, reception state. No chat, no account id, no token. */
  async adminView(channel: StoredChannel): Promise<Record<string, string | number | boolean | null>> {
    const mode = channel.config?.mode === 'operator' ? 'operator' : 'own';
    const botRef = TelegramChannelProvider.botRefOf(channel);
    const linked = await this.links.linksOf(botRef, channel.userId);
    const bot = mode === 'own' ? await this.state.find(botRef) : null;
    return {
      mode,
      botUsername: mode === 'own' && typeof channel.config?.botUsername === 'string' ? channel.config.botUsername : null,
      linkedAccounts: linked.length,
      pollStatus: bot?.status ?? null,
      pollError: bot?.lastError ?? null,
    };
  }

  async onRemove(channel: StoredChannel): Promise<void> {
    if (channel.config?.mode === 'operator') await this.links.unlinkUserOn(OPERATOR_BOT_REF, channel.userId);
    else await this.dropOwnBot(channel.userId);
  }
}

function parseTelegramInput(input: unknown): TelegramChannelInput {
  const body = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: TelegramChannelInput = {};
  if (body.mode !== undefined) {
    if (body.mode !== 'own' && body.mode !== 'operator') invalid('mode', 'MODE_INVALID');
    out.mode = body.mode;
  }
  if (body.token !== undefined) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isBotToken(token)) invalid('token', 'TELEGRAM_TOKEN_INVALID');
    out.token = token;
  }
  if (body.inbound !== undefined) {
    if (typeof body.inbound !== 'boolean') invalid('inbound', 'BOOLEAN_REQUIRED');
    out.inbound = body.inbound;
  }
  return out;
}
