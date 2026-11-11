/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The reception loop of ONE bot (extracted from AgentHub `telegram/TelegramBotPoller.ts`): long polling (`getUpdates`,
// 25 s) only while the bot's row is on, ONE poller per bot across instances (lease in its row), never two polls at once
// in a process, the offset saved after EVERY update (an ignored one too) so a restart never hands an update twice nor
// loses one. A failed poll (409: a webhook is set; 401: invalid token; network) is shown in the bot's state and waits
// longer each time (5 s → 15 min).

import { Logger } from '@nestjs/common';
import { backoffMs, botIdOf, classifyTelegramStatus, updateIdOf } from '../../pure/telegramUpdate';
import type { InteractionTelegramBotEntity } from '../../entities/InteractionTelegramBotEntity';
import { TELEGRAM_POLL_TIMEOUT_SEC, type TelegramBotClient } from './TelegramBotClient';
import type { TelegramBotStateStore } from './TelegramBotStateStore';
import type { TelegramUpdateHandler } from './TelegramUpdateHandler';

export const IDLE_MS = 30_000;
export const MIN_SPACING_MS = 1_000;
const LEASE_MS = (TELEGRAM_POLL_TIMEOUT_SEC + 35) * 1000;
const OFFSET_STALE_MS = 6 * 86_400_000;

export interface TelegramPollOutcome {
  result: 'off' | 'busy' | 'elsewhere' | 'waiting' | 'error' | 'ok';
  delayMs: number;
  handled?: number;
  error?: string;
}

export interface TelegramBotPollerOptions {
  botRef: string;
  instanceId: string;
  state: TelegramBotStateStore;
  client: TelegramBotClient;
  handler: TelegramUpdateHandler;
}

export class TelegramBotPoller {
  private readonly logger = new Logger('TelegramBotPoller');
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private lastLoggedError: string | null = null;

  constructor(private readonly options: TelegramBotPollerOptions) {}

  get botRef(): string {
    return this.options.botRef;
  }

  start(delayMs: number): void {
    this.stopped = false;
    this.schedule(delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async release(): Promise<void> {
    await this.options.state.releaseLease(this.options.botRef, this.options.instanceId);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    const outcome = await this.pollOnce().catch((): TelegramPollOutcome => ({ result: 'error', delayMs: IDLE_MS }));
    this.schedule(Math.max(MIN_SPACING_MS, outcome.delayMs));
  }

  /** One poll: every guard, `getUpdates`, then each update in order. Never two at once for this bot in a process. */
  async pollOnce(): Promise<TelegramPollOutcome> {
    if (this.running) return { result: 'busy', delayMs: MIN_SPACING_MS };
    this.running = true;
    try {
      return await this.cycle(await this.options.state.load(this.options.botRef));
    } finally {
      this.running = false;
    }
  }

  private async cycle(row: InteractionTelegramBotEntity): Promise<TelegramPollOutcome> {
    const { state, client, botRef, instanceId } = this.options;
    if (!row.enabled) {
      if (row.status !== 'off') await state.patch(botRef, { status: 'off' });
      if (row.leaseOwner === instanceId) await this.release();
      return { result: 'off', delayMs: IDLE_MS };
    }
    const bot = await state.tokenFor(botRef);
    if ('code' in bot) {
      if (row.lastError !== bot.code || row.status !== 'error') await state.patch(botRef, { status: 'error', lastError: bot.code, lastErrorAt: new Date() });
      return { result: 'error', delayMs: IDLE_MS, error: bot.code };
    }
    const waitMs = row.retryAt ? row.retryAt.getTime() - Date.now() : 0;
    if (waitMs > 0) return { result: 'waiting', delayMs: Math.min(waitMs, IDLE_MS) };
    if (!(await state.tryLease(botRef, instanceId, new Date(), LEASE_MS))) return { result: 'elsewhere', delayMs: IDLE_MS };
    const response = await client.getUpdates(bot.token, await this.offsetFor(row, bot.token));
    if (response.ok === false) return this.failed(row, classifyTelegramStatus(response.status));
    this.lastLoggedError = null;
    await state.patch(botRef, { status: 'ok', lastError: null, failures: 0, retryAt: null, lastPollAt: new Date() });
    const handled = await this.handleAll(response.result, bot.token);
    if (handled === 0 && row.updateOffset && (!row.lastUpdateAt || Date.now() - row.lastUpdateAt.getTime() >= OFFSET_STALE_MS)) await state.patch(botRef, { updateOffset: null });
    return { result: 'ok', delayMs: MIN_SPACING_MS, handled };
  }

  private async failed(row: InteractionTelegramBotEntity, code: string): Promise<TelegramPollOutcome> {
    const failures = row.failures + 1;
    const delayMs = backoffMs(failures);
    const now = new Date();
    await this.options.state.patch(this.options.botRef, { status: 'error', lastError: code, lastErrorAt: now, failures, retryAt: new Date(now.getTime() + delayMs) });
    if (this.lastLoggedError !== code) this.logger.warn(`getUpdates failed for a bot (${code}), next attempt in ${Math.round(delayMs / 1000)} s`);
    this.lastLoggedError = code;
    return { result: 'error', delayMs, error: code };
  }

  /** The offset of this bot: a token of another bot (its id changed) starts again from none. */
  private async offsetFor(row: InteractionTelegramBotEntity, token: string): Promise<string | null> {
    const botId = botIdOf(token);
    if (botId === row.botId) return row.updateOffset;
    await this.options.state.patch(this.options.botRef, { botId, updateOffset: null });
    return null;
  }

  /** In `update_id` order; the lease renewed before each one, the offset saved after each one. */
  private async handleAll(updates: unknown[], token: string): Promise<number> {
    const { state, botRef, instanceId, handler } = this.options;
    const ordered = [...updates].sort((a, b) => (updateIdOf(a) ?? 0) - (updateIdOf(b) ?? 0));
    let handled = 0;
    for (const update of ordered) {
      if (!(await state.tryLease(botRef, instanceId, new Date(), LEASE_MS))) break;
      await handler.handle(botRef, token, update);
      const updateId = updateIdOf(update);
      if (updateId !== null) await state.patch(botRef, { updateOffset: String(updateId + 1), lastUpdateAt: new Date() });
      handled += 1;
    }
    return handled;
  }
}
