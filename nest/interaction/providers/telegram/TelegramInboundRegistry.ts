/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import type { TelegramMessage, TelegramPress } from '../../pure/telegramUpdate';
import { CALLBACK_PREFIX } from '../../pure/telegramCallback';

/** Where an update came from: the bot and the linked user of its sender (`null` = an administrator without account). */
export interface TelegramInboundContext {
  botRef: string;
  userId: number | null;
  /** Sends a plain-text answer in the same chat through the same bot (the token never leaves the module). */
  reply(text: string): Promise<void>;
}

/** What a button family answers: the short notice shown by Telegram (`null` = none). */
export type TelegramCallbackHandler = (press: TelegramPress, ctx: TelegramInboundContext) => Promise<string | null>;
export type TelegramMessageHandler = (message: TelegramMessage, ctx: TelegramInboundContext) => Promise<void>;
export type TelegramNotificationListener = (event: { botRef: string; userId: number; chatId: string; messageId: string | null }) => void;

/**
 * Extension point of the Telegram inbound channel (04 §4.7): an app (AgentHub, C2) registers its own button families
 * (`dc:`, `ir:`…), commands, message and voice handlers; the module routes to them updates of LINKED senders only.
 * The prefix `ix:` is reserved for the module's question cards.
 */
@Injectable()
export class TelegramInboundRegistry {
  private readonly families = new Map<string, TelegramCallbackHandler>();
  private readonly commands = new Map<string, TelegramMessageHandler>();
  private messageHandler: TelegramMessageHandler | null = null;
  private voiceHandler: TelegramMessageHandler | null = null;
  private readonly sentListeners = new Set<TelegramNotificationListener>();

  addCallbackFamily(prefix: string, handler: TelegramCallbackHandler): () => void {
    if (!/^[a-z]{1,8}:$/.test(prefix) || prefix === CALLBACK_PREFIX) throw new Error(`[interaction] invalid or reserved callback prefix "${prefix}"`);
    if (this.families.has(prefix)) throw new Error(`[interaction] callback prefix "${prefix}" already registered`);
    this.families.set(prefix, handler);
    return () => this.families.delete(prefix);
  }

  addCommandHandler(name: string, handler: TelegramMessageHandler): () => void {
    const command = name.replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9_]{1,32}$/.test(command) || command === 'start') throw new Error(`[interaction] invalid or reserved command "${name}"`);
    this.commands.set(command, handler);
    return () => this.commands.delete(command);
  }

  setMessageHandler(handler: TelegramMessageHandler | null): void {
    this.messageHandler = handler;
  }

  setVoiceHandler(handler: TelegramMessageHandler | null): void {
    this.voiceHandler = handler;
  }

  onNotificationSent(listener: TelegramNotificationListener): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }

  familyFor(data: string): TelegramCallbackHandler | null {
    const prefix = /^([a-z]{1,8}:)/.exec(data)?.[1];
    return prefix && prefix !== CALLBACK_PREFIX ? this.families.get(prefix) ?? null : null;
  }

  commandFor(name: string): TelegramMessageHandler | null {
    return this.commands.get(name) ?? null;
  }

  message(): TelegramMessageHandler | null {
    return this.messageHandler;
  }

  voice(): TelegramMessageHandler | null {
    return this.voiceHandler;
  }

  notificationSent(event: { botRef: string; userId: number; chatId: string; messageId: string | null }): void {
    for (const listener of this.sentListeners) {
      try {
        listener(event);
      } catch {
        /* a listener never blocks a send */
      }
    }
  }
}
