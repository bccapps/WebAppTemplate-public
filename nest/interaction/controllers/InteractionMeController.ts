/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Delete, Get, HttpCode, Optional, Param, Patch, Post, Put, Req, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequireUserInterceptor } from '../../common/auth/RequireUserInterceptor';
import type { ChannelTestResultDto } from '../dtos/ChannelTestResultDto';
import type { InboxDto } from '../dtos/InboxDto';
import type { InteractionChannelDto } from '../dtos/InteractionChannelDto';
import type { InteractionChannelSaveDto } from '../dtos/InteractionChannelSaveDto';
import type { InteractionNoticeDto } from '../dtos/InteractionNoticeDto';
import type { InteractionPrefDto } from '../dtos/InteractionPrefDto';
import type { InteractionTicketDto } from '../dtos/InteractionTicketDto';
import type { TelegramLinkCodeDto } from '../dtos/TelegramLinkCodeDto';
import { InteractionError } from '../errors/InteractionError';
import { InteractionErrorInterceptor } from '../errors/InteractionHttpException';
import { toTicketDto } from '../mappers/InteractionMapper';
import { parseAnswerBody, parseEndpointBody, parseKind, parseReadBody, parseUuid, parseWebPushSubscribe } from '../pure/bodies';
import { BrowserChannelProvider } from '../providers/browser/BrowserChannelProvider';
import { TelegramChannelProvider } from '../providers/telegram/TelegramChannelProvider';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionDeliveryService } from '../services/InteractionDeliveryService';
import { InteractionInboxService } from '../services/InteractionInboxService';
import { InteractionPrefService } from '../services/InteractionPrefService';
import { InteractionProviderRegistry } from '../services/InteractionProviderRegistry';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { ownerOf, RequireHumanSessionInterceptor } from './interactionRequest';

const TEN_PER_MINUTE = { default: { limit: 10, ttl: 60_000 } };

/**
 * The signed-in user's routes (04 §11.1): `/api/v1/interaction/me/*`, a USER session only (`RequireUserInterceptor`
 * refuses no session, the admin key and local trust; `RequireHumanSessionInterceptor` also refuses a service key or a
 * machine credential). Every id of a path is scoped to the session user: someone else's ticket or notice is `404`.
 */
@Controller('/api/v1/interaction/me')
@UseInterceptors(RequireUserInterceptor, RequireHumanSessionInterceptor, InteractionErrorInterceptor)
export class InteractionMeController {
  constructor(
    private readonly channels: InteractionChannelService,
    private readonly delivery: InteractionDeliveryService,
    private readonly prefs: InteractionPrefService,
    private readonly inbox: InteractionInboxService,
    private readonly tickets: InteractionTicketService,
    private readonly registry: InteractionProviderRegistry,
    @Optional() private readonly telegram?: TelegramChannelProvider,
    @Optional() private readonly browser?: BrowserChannelProvider,
  ) {}

  // Channels ------------------------------------------------------------------

  @Get('channels')
  list(@Req() req: Request): Promise<InteractionChannelDto[]> {
    return this.channels.list(ownerOf(req).userId);
  }

  @Post('channels/webhook/secret')
  @Throttle(TEN_PER_MINUTE)
  rotateWebhookSecret(@Req() req: Request): Promise<InteractionChannelSaveDto> {
    return this.channels.rotateSecret(ownerOf(req), 'webhook');
  }

  @Post('channels/telegram/link-code')
  @Throttle(TEN_PER_MINUTE)
  telegramLinkCode(@Req() req: Request): Promise<TelegramLinkCodeDto> {
    return this.telegramProvider().linkCode(ownerOf(req));
  }

  @Delete('channels/telegram/links/:linkId')
  async unlinkTelegram(@Req() req: Request, @Param('linkId') linkId: string): Promise<InteractionChannelDto> {
    const owner = ownerOf(req);
    await this.telegramProvider().unlink(owner, parseUuid(linkId));
    return this.channels.get(owner.userId, 'telegram');
  }

  @Put('channels/:kind')
  @Throttle(TEN_PER_MINUTE)
  configure(@Req() req: Request, @Param('kind') kind: string, @Body() body: unknown): Promise<InteractionChannelSaveDto> {
    return this.channels.configure(ownerOf(req), parseKind(kind), body);
  }

  @Patch('channels/:kind')
  setState(@Req() req: Request, @Param('kind') kind: string, @Body() body: unknown): Promise<InteractionChannelDto> {
    return this.channels.setState(ownerOf(req), parseKind(kind), body);
  }

  @Delete('channels/:kind')
  @HttpCode(200)
  async remove(@Req() req: Request, @Param('kind') kind: string): Promise<{ success: true }> {
    await this.channels.remove(ownerOf(req), parseKind(kind));
    return { success: true };
  }

  @Post('channels/:kind/verify')
  @Throttle(TEN_PER_MINUTE)
  verify(@Req() req: Request, @Param('kind') kind: string, @Body() body: unknown): Promise<InteractionChannelDto> {
    return this.channels.verify(ownerOf(req), parseKind(kind), body);
  }

  @Post('channels/:kind/test')
  @Throttle(TEN_PER_MINUTE)
  test(@Req() req: Request, @Param('kind') kind: string): Promise<ChannelTestResultDto> {
    return this.channels.test(ownerOf(req), parseKind(kind), (provider, channel) => this.delivery.ping(provider, channel));
  }

  // Web Push ------------------------------------------------------------------

  @Get('webpush/public-key')
  async webPushPublicKey(): Promise<{ publicKey: string }> {
    return { publicKey: await this.browserProvider().publicKey() };
  }

  @Post('webpush/subscriptions')
  @Throttle(TEN_PER_MINUTE)
  async subscribe(@Req() req: Request, @Body() body: unknown): Promise<{ success: true }> {
    await this.browserProvider().subscribe(ownerOf(req), parseWebPushSubscribe(body));
    return { success: true };
  }

  @Delete('webpush/subscriptions')
  @HttpCode(200)
  async unsubscribe(@Req() req: Request, @Body() body: unknown): Promise<{ success: true }> {
    await this.browserProvider().unsubscribe(ownerOf(req), parseEndpointBody(body));
    return { success: true };
  }

  /**
   * Same as the `DELETE` above, for clients that cannot send a body with `DELETE` (the common `HttpService`): the
   * endpoint is a target and must never travel in a URL (query strings end up in access logs).
   */
  @Post('webpush/subscriptions/remove')
  @HttpCode(200)
  async unsubscribeByPost(@Req() req: Request, @Body() body: unknown): Promise<{ success: true }> {
    await this.browserProvider().unsubscribe(ownerOf(req), parseEndpointBody(body));
    return { success: true };
  }

  // Preferences ---------------------------------------------------------------

  @Get('prefs')
  getPrefs(@Req() req: Request): Promise<InteractionPrefDto> {
    return this.prefs.get(ownerOf(req).userId);
  }

  @Put('prefs')
  savePrefs(@Req() req: Request, @Body() body: unknown): Promise<InteractionPrefDto> {
    return this.prefs.save(ownerOf(req).userId, body);
  }

  // Inbox ---------------------------------------------------------------------

  @Get('inbox')
  getInbox(@Req() req: Request): Promise<InboxDto> {
    return this.inbox.inbox(ownerOf(req).userId);
  }

  @Get('notices/:id')
  notice(@Req() req: Request, @Param('id') id: string): Promise<InteractionNoticeDto> {
    return this.inbox.notice(ownerOf(req).userId, parseUuid(id));
  }

  @Post('notices/read')
  @HttpCode(200)
  async markRead(@Req() req: Request, @Body() body: unknown): Promise<{ success: true }> {
    await this.inbox.markRead(ownerOf(req).userId, parseReadBody(body));
    return { success: true };
  }

  @Get('tickets/:id')
  ticket(@Req() req: Request, @Param('id') id: string): Promise<InteractionTicketDto> {
    return this.tickets.ticketFor(ownerOf(req).userId, parseUuid(id));
  }

  @Post('tickets/:id/answer')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async answer(@Req() req: Request, @Param('id') id: string, @Body() body: unknown): Promise<InteractionTicketDto> {
    const owner = ownerOf(req);
    const input = parseAnswerBody(body);
    const ticket = await this.tickets.answer({ ticketId: parseUuid(id), userId: owner.userId, via: 'inapp', actionId: input.actionId, stepUpProof: input.stepUpProof });
    return toTicketDto(ticket, owner.userId);
  }

  private telegramProvider(): TelegramChannelProvider {
    if (!this.telegram || this.registry.get('telegram') !== this.telegram || !this.registry.enabledKinds().includes('telegram')) throw new InteractionError('KIND_DISABLED');
    return this.telegram;
  }

  private browserProvider(): BrowserChannelProvider {
    if (!this.browser || this.registry.get('browser') !== this.browser || !this.registry.enabledKinds().includes('browser')) throw new InteractionError('KIND_DISABLED');
    return this.browser;
  }
}
