/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { TelegramBotClient, type TelegramCallResult, type TelegramInlineKeyboard } from './TelegramBotClient';
import { TelegramBotStateStore } from './TelegramBotStateStore';

/** Result of a send: the message id, or a code (`TELEGRAM_<status>`, `QUEUE_FULL`). */
export interface TelegramSendOutcome {
  ok: boolean;
  messageId: string | null;
  code: string | null;
}

/** Messages waiting for one bot: beyond, a send is dropped (`QUEUE_FULL`) rather than queued for ever (04 §5). */
export const MAX_QUEUED_PER_BOT = 20;

/**
 * One queue per bot (the client spaces the sends of a bot by a second, 04 §5): sends run one after the other, at most
 * `MAX_QUEUED_PER_BOT` waiting; the excess is dropped and counted (`dropped_count`).
 */
@Injectable()
export class TelegramSender {
  private readonly queues = new Map<string, { tail: Promise<unknown>; size: number }>();

  constructor(
    private readonly client: TelegramBotClient,
    private readonly state: TelegramBotStateStore,
  ) {}

  /** Runs `work` in the bot's queue; `QUEUE_FULL` when it is full. */
  private async enqueue<T>(botRef: string, work: () => Promise<T>): Promise<T | 'QUEUE_FULL'> {
    const queue = this.queues.get(botRef) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= MAX_QUEUED_PER_BOT) {
      await this.state.increment(botRef, 'droppedCount');
      return 'QUEUE_FULL';
    }
    queue.size += 1;
    this.queues.set(botRef, queue);
    const run = queue.tail.then(work, work);
    queue.tail = run.catch(() => undefined).finally(() => {
      queue.size -= 1;
      if (queue.size === 0 && this.queues.get(botRef) === queue) this.queues.delete(botRef);
    });
    return run;
  }

  /** A plain-text message; `TELEGRAM_<status>` / `QUEUE_FULL` on failure. */
  async send(botRef: string, token: string, chatId: string, text: string, keyboard?: TelegramInlineKeyboard): Promise<TelegramSendOutcome> {
    const result = await this.enqueue(botRef, () => this.client.sendMessage(token, chatId, text, keyboard));
    if (result === 'QUEUE_FULL') return { ok: false, messageId: null, code: 'QUEUE_FULL' };
    if (result.ok === false) return { ok: false, messageId: null, code: `TELEGRAM_${result.status}` };
    await this.state.increment(botRef, 'sentCount');
    return { ok: true, messageId: result.result.messageId, code: null };
  }

  async edit(botRef: string, token: string, chatId: string, messageId: string, text: string): Promise<TelegramCallResult<true> | 'QUEUE_FULL'> {
    return this.enqueue(botRef, () => this.client.editMessageText(token, chatId, messageId, text));
  }
}
