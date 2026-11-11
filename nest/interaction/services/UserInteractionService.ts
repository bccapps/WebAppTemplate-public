/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InteractionWebPushSubscriptionEntity } from '../entities/InteractionWebPushSubscriptionEntity';
import { TelegramLinkService } from '../providers/telegram/TelegramLinkService';
import { InteractionError } from '../errors/InteractionError';
import { parseAnswerBody, parseUuid } from '../pure/bodies';
import { normalizeRecipients } from '../pure/validation';
import type {
  ChannelKind,
  DeliveryReport,
  InteractionAnswerHandler,
  InteractionAnswerOptions,
  InteractionCategory,
  InteractionQuestion,
  InteractionTicket,
  UserInteractionApi,
  UserNotice,
} from '../types/interactionTypes';
import { INTERACTION_DIRECTORY, type InteractionDirectory } from '../types/ports';
import type { InteractionChannelProvider } from '../types/providerTypes';
import { InteractionChannelService } from './InteractionChannelService';
import { InteractionDeliveryService } from './InteractionDeliveryService';
import { InteractionInboxService } from './InteractionInboxService';
import { INAPP_KIND, InteractionProviderRegistry } from './InteractionProviderRegistry';
import { InteractionPrefService } from './InteractionPrefService';
import { InteractionSignals } from './InteractionRuntime';
import { InteractionTicketService } from './InteractionTicketService';

const MAX_NOTIFY_MANY = 100;

/** `answerFromProvider`: the ticket, the user who answered in the app's channel, the action, the step-up proof id if any. */
export interface ProviderAnswerInput {
  ticketId: string;
  userId: number;
  actionId: string;
  stepUpProof?: string | null;
}

/**
 * What apps use (04 §4.5, named `UserInteractionService` by 04 §20): notices, questions, outcome handlers, reachable
 * channels, account deletion. Global: consumers inject it, they never import `InteractionModule`.
 */
@Injectable()
export class UserInteractionService implements UserInteractionApi, OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly delivery: InteractionDeliveryService,
    private readonly tickets: InteractionTicketService,
    private readonly channels: InteractionChannelService,
    private readonly prefs: InteractionPrefService,
    private readonly inbox: InteractionInboxService,
    private readonly registry: InteractionProviderRegistry,
    private readonly signals: InteractionSignals,
    private readonly telegramLinks: TelegramLinkService,
    @InjectRepository(InteractionWebPushSubscriptionEntity) private readonly subscriptions: Repository<InteractionWebPushSubscriptionEntity>,
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
  ) {}

  /** 04 §9: every new Telegram link is announced on the user's OTHER channels (a `security` notice). */
  onModuleInit(): void {
    this.unsubscribe = this.signals.onTelegramLinked(async ({ userId }) => {
      await this.delivery.notify(
        userId,
        { type: 'interaction.telegram.linked', source: 'interaction', category: 'security', title: { key: 'interaction.server.telegramLinked.title' }, body: { key: 'interaction.server.telegramLinked.body' } },
        { excludeKinds: ['telegram'] },
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  notify(userId: number, notice: UserNotice): Promise<DeliveryReport> {
    return this.delivery.notify(userId, notice);
  }

  /** At most 100 recipients; one report each. */
  async notifyMany(userIds: number[], notice: UserNotice): Promise<DeliveryReport[]> {
    const ids = normalizeRecipients(userIds, MAX_NOTIFY_MANY, 'INVALID_NOTICE');
    this.delivery.validate(notice);
    const reports: DeliveryReport[] = [];
    for (const id of ids) reports.push(await this.delivery.notify(id, notice));
    return reports;
  }

  async notifyAdmins(notice: UserNotice): Promise<DeliveryReport[]> {
    const admins = (await this.directory.adminUserIds()).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, MAX_NOTIFY_MANY);
    if (admins.length === 0) return [];
    return this.notifyMany(admins, notice);
  }

  ask(recipients: number | number[], question: InteractionQuestion): Promise<InteractionTicket> {
    return this.tickets.ask(recipients, question);
  }

  cancel(source: string, correlationId: string, reason: string): Promise<boolean> {
    return this.tickets.cancel(source, correlationId, reason);
  }

  getTicket(ticketId: string): Promise<InteractionTicket | null> {
    return this.tickets.getTicket(ticketId);
  }

  /**
   * An answer received by an app's own reply channel INSIDE the app (04 §22: AgentHub's messaging, C2). `provider` must
   * be the very instance registered for its kind, declare `proof: 'in_app'` and the `reply` capability; anything else is
   * `CHANNEL_NOT_ALLOWED`. Then exactly the in-app rules: recipient and active (`NOT_FOUND`), the kind in the ticket's
   * `answerableFrom`, the user's channel of that kind on and not disabled by an administrator, a known action, the
   * step-up proof of a `freshProof` question consumed by the winner only, one conditional UPDATE (first answer wins,
   * never after `expires_at`), audit line. The provider passes the proof id its in-app interface obtained (`stepUpProof`).
   */
  async answerFromProvider(provider: InteractionChannelProvider, input: ProviderAnswerInput): Promise<InteractionTicket> {
    const kind = provider && typeof provider.kind === 'string' ? provider.kind : '';
    if (!kind || this.registry.get(kind) !== provider || provider.proof !== 'in_app' || !provider.capabilities?.has('reply')) throw new InteractionError('CHANNEL_NOT_ALLOWED');
    const ticketId = parseUuid(input?.ticketId);
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0) throw new InteractionError('NOT_FOUND');
    const { actionId, stepUpProof } = parseAnswerBody({ actionId: input.actionId, stepUpProof: input.stepUpProof ?? null });
    const answered = await this.tickets.answer({ ticketId, userId: input.userId, via: kind, actionId, stepUpProof });
    return (await this.tickets.getTicket(answered.id)) as InteractionTicket;
  }

  /** One handler per kind; bind it to its source (`{ source }`), and check `answer.source` / `answer.ticketId` in it. */
  onAnswer(kind: string, handler: InteractionAnswerHandler, options?: InteractionAnswerOptions): () => void {
    return this.tickets.onAnswer(kind, handler, options);
  }

  /** `['inapp', …ready channels the routing of `category` keeps]` (the creation of an « ask » credential checks it). */
  async reachableKinds(userId: number, category: InteractionCategory): Promise<ChannelKind[]> {
    if (!(await this.directory.isActive(userId))) return [];
    const enabled = this.registry.enabledKinds();
    const route = (await this.prefs.planPrefs(userId)).routing?.[category] ?? null;
    const ready = (await this.channels.planChannels(userId)).filter((c) => c.ready && c.enabled && !c.adminDisabled && enabled.includes(c.kind)).map((c) => c.kind);
    const routed = route === null ? ready : ready.filter((kind) => route.includes(kind));
    return [INAPP_KIND, ...(routed.length === 0 && category !== 'info' ? ready : routed)];
  }

  /** Account deletion (04 §16.2): channels, secrets, subscriptions, links, preferences, notices; its lone tickets cancelled. */
  async forgetUser(userId: number): Promise<void> {
    await this.tickets.forgetUser(userId);
    await this.channels.forgetUser(userId);
    await this.subscriptions.delete({ userId });
    await this.telegramLinks.forgetUser(userId);
    await this.prefs.forget(userId);
    await this.inbox.forgetUser(userId);
    await this.delivery.forgetUser(userId);
  }
}
