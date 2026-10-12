/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';

const THROTTLE_MS = 60_000;

@Injectable()
export class ProwlService {
  private readonly logger = new Logger(ProwlService.name);
  private readonly endpoint =
    process.env.PROWL_API_URL ?? 'https://api.prowlapp.com/publicapi';
  private readonly application =
    process.env.PROJECT_NAME ?? 'UnknownApp';
  private readonly lastNotifyMap = new Map<string, number>();

  async notify(event: string, description: string, application?: string) {
    const apiKey = process.env.PROWL_API_KEY;
    if (!apiKey) {
      this.logger.warn('PROWL_API_KEY is missing; skipping Prowl notification');
      return;
    }

    const body = new URLSearchParams({
      apikey: apiKey,
      application: application ?? this.application,
      event,
      description,
    }).toString();

    const url = `${this.endpoint}/add`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(
        `Prowl notification failed (${response.status}): ${text}`,
      );
      throw new Error(`Prowl notification failed: ${response.statusText}`);
    }

    this.logger.log(`Prowl notification sent: ${event}`);
  }

  async safeNotify(event: string, description: string, application?: string): Promise<void> {
    const now = Date.now();
    const lastSent = this.lastNotifyMap.get(event) ?? 0;
    if (now - lastSent < THROTTLE_MS) {
      this.logger.debug(`Prowl notification throttled for event: ${event}`);
      return;
    }
    this.lastNotifyMap.set(event, now);
    try {
      await this.notify(event, description, application);
    } catch (error) {
      this.logger.error(`Prowl safeNotify failed: ${(error as Error).message}`);
    }
  }
}
