/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { IsNull, Not, Repository } from 'typeorm';
import { BrandService } from '../../../common/services/BrandService';
import { InstanceRoleService } from '../../../common/services/InstanceRoleService';
import { InteractionUserChannelEntity } from '../../entities/InteractionUserChannelEntity';
import { INTERACTION_OPTIONS, INTERACTION_DIRECTORY, type InteractionDirectory } from '../../types/ports';
import type { InteractionRuntimeOptions } from '../../interactionOptions';
import { botIdOf, OPERATOR_BOT_REF, userBotRef } from '../../pure/telegramUpdate';
import { InteractionConfig } from '../../services/InteractionConfig';
import { InteractionKeyService } from '../../services/InteractionKeyService';
import { errorCode, InteractionSignals } from '../../services/InteractionRuntime';
import { TelegramBotClient } from './TelegramBotClient';
import { TelegramBotPoller, type TelegramPollOutcome } from './TelegramBotPoller';
import { TelegramBotStateStore } from './TelegramBotStateStore';
import { TelegramUpdateHandler } from './TelegramUpdateHandler';

const RECONCILE_MS = 30_000;
const START_DELAY_MS = 5_000;

/**
 * Which bots are listened to, and how (04 §9, §11.3; extracted from AgentHub `UserTelegramBotService`): the operator's
 * bot when the mode includes it and its token is set; every user's own bot whose channel is on, NOT disabled by an
 * administrator (invariant 9), with a token, of an active account, at most `interaction_telegramMaxUserBots` (oldest
 * first). Long polling by default (one poller per bot across instances); with `interaction_telegramInbound = webhook`
 * and the webhook route on, the bot's webhook is set instead. Reconciled every 30 s on workers and at once on a change.
 */
@Injectable()
export class TelegramBotFleet implements OnApplicationBootstrap, OnModuleDestroy {
  readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 64);
  private readonly logger = new Logger('TelegramBotFleet');
  private readonly pollers = new Map<string, TelegramBotPoller>();
  private readonly webhooks = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private background = false;
  private reconciling: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @InjectRepository(InteractionUserChannelEntity) private readonly channels: Repository<InteractionUserChannelEntity>,
    private readonly state: TelegramBotStateStore,
    private readonly client: TelegramBotClient,
    private readonly handler: TelegramUpdateHandler,
    private readonly config: InteractionConfig,
    private readonly keys: InteractionKeyService,
    private readonly brand: BrandService,
    private readonly role: InstanceRoleService,
    private readonly signals: InteractionSignals,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
    @Inject(INTERACTION_OPTIONS) private readonly options: InteractionRuntimeOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.builtIn.telegram || !this.options.background || !this.role.isWorker()) return;
    this.background = true;
    this.unsubscribe = this.signals.onChannelsChanged(({ kind }) => {
      if (kind === 'telegram') void this.reconcile().catch(() => undefined);
    });
    const loop = (): void => {
      void this.reconcile()
        .catch((error: unknown) => this.logger.warn(`reconcile failed (${errorCode(error)})`))
        .finally(() => {
          if (!this.background) return;
          this.timer = setTimeout(loop, RECONCILE_MS);
          this.timer.unref?.();
        });
    };
    this.timer = setTimeout(loop, START_DELAY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.background = false;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const poller of this.pollers.values()) {
      poller.stop();
      void poller.release().catch(() => undefined);
    }
    this.pollers.clear();
  }

  /** The bots listened to now (tests and the admin view). */
  polledBots(): string[] {
    return [...this.pollers.keys()];
  }

  /** One run at a time. */
  async reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileNow().finally(() => {
      this.reconciling = null;
    });
    await this.reconciling;
  }

  /** One poll of a bot (tests drive it); null when that bot is not wanted. */
  async pollOnce(botRef: string): Promise<TelegramPollOutcome | null> {
    if (!this.pollers.has(botRef)) await this.reconcile();
    const poller = this.pollers.get(botRef);
    return poller ? poller.pollOnce() : null;
  }

  /** The bots that must be listened to now. */
  async wantedBots(): Promise<string[]> {
    const mode = this.config.telegramMode();
    const wanted: string[] = [];
    if ((mode === 'operator' || mode === 'both') && this.config.operatorBotToken()) wanted.push(OPERATOR_BOT_REF);
    if (mode !== 'own' && mode !== 'both') return wanted;
    const rows = await this.channels.find({ where: { kind: 'telegram', enabled: true, adminDisabled: false, secretId: Not(IsNull()) }, order: { createdAt: 'ASC' } });
    const max = this.config.number('interaction_telegramMaxUserBots', 0, 1000);
    let users = 0;
    for (const row of rows) {
      if (users >= max) break;
      if (row.config?.mode !== 'own') continue;
      if (!(await this.directory.isActive(row.userId).catch(() => false))) continue;
      wanted.push(userBotRef(row.userId));
      users += 1;
    }
    return wanted;
  }

  private webhookMode(): boolean {
    return this.options.routes.telegramWebhook && this.config.telegramInbound() === 'webhook';
  }

  private async reconcileNow(): Promise<void> {
    if (!this.options.builtIn.telegram) return;
    const wanted = new Set(await this.wantedBots());
    for (const botRef of await this.state.enabledBots()) {
      if (!wanted.has(botRef)) await this.state.patch(botRef, { enabled: false, status: 'off', leaseOwner: null, leaseUntil: null });
    }
    for (const [botRef, poller] of [...this.pollers.entries()]) {
      if (wanted.has(botRef) && !this.webhookMode()) continue;
      this.pollers.delete(botRef);
      poller.stop();
      await poller.release().catch(() => undefined);
    }
    for (const botRef of wanted) {
      const row = await this.state.load(botRef);
      if (!row.enabled) await this.state.patch(botRef, { enabled: true, status: 'starting', failures: 0, retryAt: null, lastError: null, lastErrorAt: null });
      if (this.webhookMode()) await this.ensureWebhook(botRef);
      else await this.ensurePoller(botRef);
    }
  }

  private async ensurePoller(botRef: string): Promise<void> {
    if (this.webhooks.has(botRef)) {
      const bot = await this.state.tokenFor(botRef);
      if ('token' in bot) await this.client.deleteWebhook(bot.token);
      this.webhooks.delete(botRef);
    }
    if (this.pollers.has(botRef)) return;
    const poller = new TelegramBotPoller({ botRef, instanceId: this.instanceId, state: this.state, client: this.client, handler: this.handler });
    this.pollers.set(botRef, poller);
    if (this.background) poller.start(0);
  }

  /**
   * Webhook mode: `setWebhook(<api>/api/v1/interaction/telegram/webhook/<botRef>/<botId>, <per-bot secret>)` once per bot
   * and URL (the bot id in the path lets the route check the secret before any database read, review F7).
   */
  private async ensureWebhook(botRef: string): Promise<void> {
    const bot = await this.state.tokenFor(botRef);
    if ('code' in bot) return this.state.patch(botRef, { status: 'error', lastError: bot.code, lastErrorAt: new Date() });
    const botId = botIdOf(bot.token) ?? '';
    const url = this.brand.apiAbsoluteUrl(`api/v1/interaction/telegram/webhook/${botRef}/${botId}`);
    if (!/^https:\/\//.test(url)) return this.state.patch(botRef, { status: 'error', lastError: 'NOT_CONFIGURED', lastErrorAt: new Date() });
    const marker = `${botId}|${url}`;
    if (this.webhooks.get(botRef) === marker) return;
    const result = await this.client.setWebhook(bot.token, url, this.keys.webhookSecret(botRef, botId));
    if (result.ok === false) return this.state.patch(botRef, { status: 'error', lastError: `TELEGRAM_${result.status}`, lastErrorAt: new Date() });
    this.webhooks.set(botRef, marker);
    await this.state.patch(botRef, { status: 'webhook', botId, lastError: null });
  }
}
