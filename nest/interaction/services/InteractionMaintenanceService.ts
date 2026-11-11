/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CronLockService } from '../../common/services/CronLockService';
import { InstanceRoleService } from '../../common/services/InstanceRoleService';
import type { InteractionRuntimeOptions } from '../interactionOptions';
import { TelegramBotStateStore, WEBHOOK_SEEN_RETENTION_MS } from '../providers/telegram/TelegramBotStateStore';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { INTERACTION_OPTIONS } from '../types/ports';
import { InteractionConfig } from './InteractionConfig';
import { InteractionDeliveryService } from './InteractionDeliveryService';
import { InteractionInboxService } from './InteractionInboxService';
import { errorCode } from './InteractionRuntime';
import { InteractionSendQuotaService } from './InteractionSendQuotaService';
import { InteractionTicketService } from './InteractionTicketService';

const DAY_MS = 86_400_000;

/**
 * Background work on workers only (`InstanceRoleService.isWorker()`): the expiry sweep and the outcome retries every
 * `interaction_expirySweepMs` under `runExclusive('interaction.expire')`, the daily purge under
 * `runIfDue('interaction.purge', 24 h)` (deliveries, notices, closed tickets, link codes, send counters, the
 * webhook's seen updates).
 */
@Injectable()
export class InteractionMaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('InteractionMaintenance');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tickets: InteractionTicketService,
    private readonly delivery: InteractionDeliveryService,
    private readonly inbox: InteractionInboxService,
    private readonly quota: InteractionSendQuotaService,
    private readonly links: TelegramLinkService,
    private readonly bots: TelegramBotStateStore,
    private readonly config: InteractionConfig,
    private readonly cronLock: CronLockService,
    private readonly role: InstanceRoleService,
    @Inject(INTERACTION_OPTIONS) private readonly options: InteractionRuntimeOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.background || !this.role.isWorker()) return;
    this.running = true;
    this.schedule();
  }

  onModuleDestroy(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.config.number('interaction_expirySweepMs', 5000, 600000));
    this.timer.unref?.();
  }

  /**
   * One pass: sweep + retries (exclusive), then the purge when it is due. The callbacks never throw: an error is logged
   * here by its code (the common lock would log its message and stack, review F6).
   */
  async tick(now = new Date()): Promise<void> {
    const sweep = async (): Promise<void> => {
      await this.tickets.expireDue(now);
      await this.tickets.retryDispatches(now);
    };
    await this.cronLock.runExclusive('interaction.expire', () => sweep().catch((error: unknown) => this.logger.warn(`sweep failed (${errorCode(error)})`))).catch(() => undefined);
    await this.cronLock.runIfDue('interaction.purge', DAY_MS, () => this.purge(now).catch((error: unknown) => this.logger.warn(`purge failed (${errorCode(error)})`))).catch(() => undefined);
  }

  async purge(now = new Date()): Promise<void> {
    const days = (key: string): Date => new Date(now.getTime() - this.config.number(key, 1, 3650) * DAY_MS);
    await this.delivery.purge(days('interaction_deliveryRetentionDays'));
    await this.inbox.purge(days('interaction_noticeRetentionDays'));
    await this.tickets.purge(days('interaction_ticketRetentionDays'));
    await this.links.purgeCodes(new Date(now.getTime() - DAY_MS));
    await this.quota.purge(now.getTime());
    await this.bots.purgeSeenUpdates(new Date(now.getTime() - WEBHOOK_SEEN_RETENTION_MS));
  }
}
