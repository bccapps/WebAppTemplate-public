/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post, UseInterceptors } from '@nestjs/common';
import { Public } from '../../common/decorators/Public';
import { InteractionErrorInterceptor } from '../errors/InteractionHttpException';
import { constantTimeEqual } from '../pure/codes';
import { botIdOf, isBotRef, updateIdOf } from '../pure/telegramUpdate';
import { TelegramBotStateStore, WEBHOOK_SEEN_RETENTION_MS } from '../providers/telegram/TelegramBotStateStore';
import { TelegramUpdateHandler } from '../providers/telegram/TelegramUpdateHandler';
import { InteractionConfig } from '../services/InteractionConfig';
import { InteractionKeyService } from '../services/InteractionKeyService';

const BOT_ID = /^[1-9]\d{0,19}$/;

/**
 * Optional Telegram webhook (04 §11.3, `routes.telegramWebhook` and `interaction_telegramInbound = webhook`; both off by
 * default). The URL names the bot reference AND the bot's public id (`/webhook/<botRef>/<botId>`, set by the fleet), so
 * the secret `X-Telegram-Bot-Api-Secret-Token` (derived from the master key, the reference and the id) is compared in
 * constant time BEFORE any database read or token decryption (review F7): an unauthenticated request costs one HMAC
 * and gets the same 404 whatever the bot. Then the bot must still be that id, and the update is handled AT MOST ONCE
 * (second review, finding 3): its `update_id` is claimed in the set of updates seen (`TelegramBotStateStore.claimUpdate`,
 * before the handling); a replay or a re-delivery is acknowledged without being handled again, an older update
 * arriving after a newer one is handled once; a `message` dated before the set's retention (a replay of captured
 * traffic) and an update without `update_id` are acknowledged, not handled. Same handler as long polling.
 */
@Controller('/api/v1/interaction/telegram/webhook')
@UseInterceptors(InteractionErrorInterceptor)
export class TelegramWebhookController {
  constructor(
    private readonly state: TelegramBotStateStore,
    private readonly handler: TelegramUpdateHandler,
    private readonly keys: InteractionKeyService,
    private readonly config: InteractionConfig,
  ) {}

  @Public()
  @Post(':botRef/:botId')
  @HttpCode(200)
  async receive(@Param('botRef') botRef: string, @Param('botId') botId: string, @Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: unknown): Promise<{ ok: true }> {
    if (this.config.telegramInbound() !== 'webhook' || !isBotRef(botRef) || !BOT_ID.test(botId)) throw new NotFoundException();
    if (!constantTimeEqual(secret ?? '', this.keys.webhookSecret(botRef, botId))) throw new NotFoundException();
    const bot = await this.state.tokenFor(botRef);
    if (!('token' in bot) || botIdOf(bot.token) !== botId) throw new NotFoundException();
    const updateId = updateIdOf(update);
    if (updateId === null || isStaleMessage(update, Date.now())) return { ok: true };
    if (await this.state.claimUpdate(botRef, updateId)) await this.handler.handle(botRef, bot.token, update);
    return { ok: true };
  }
}

/** A `message` update dated before the webhook's memory of seen updates (`date` in seconds): never handled. */
export function isStaleMessage(update: unknown, now: number): boolean {
  const message = update && typeof update === 'object' ? (update as { message?: { date?: unknown } }).message : undefined;
  const date = message && typeof message === 'object' ? message.date : undefined;
  return typeof date === 'number' && Number.isFinite(date) && date * 1000 < now - WEBHOOK_SEEN_RETENTION_MS;
}
