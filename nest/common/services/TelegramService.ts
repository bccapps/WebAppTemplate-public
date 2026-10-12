/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  async send(token: string, destination: string, text: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destination, text, parse_mode: 'HTML' }),
      });
      if (!response.ok) {
        const body = await response.text();
        this.logger.warn(`[Telegram] sendMessage failed (${response.status}): ${body}`);
      }
    } catch (error) {
      this.logger.warn('[Telegram] sendMessage error', error as Error);
    }
  }

  async sendWithPriority(
    token: string,
    chatId: string | null,
    channelId: string | null,
    text: string,
  ): Promise<void> {
    if (channelId) {
      await this.send(token, channelId, text);
      return;
    }
    if (chatId) {
      await this.send(token, chatId, text);
    }
  }
}
