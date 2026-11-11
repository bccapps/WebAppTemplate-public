/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, HttpCode, Optional, Param, Patch, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { And, LessThanOrEqual, MoreThanOrEqual, Repository, type FindOptionsWhere } from 'typeorm';
import { AdminOnlyInterceptor } from '../../common/interceptors/AdminOnlyInterceptor';
import { RejectApiTokenInterceptor } from '../../common/interceptors/RejectApiTokenInterceptor';
import type { InteractionChannelAdminDto } from '../dtos/InteractionChannelAdminDto';
import type { InteractionDeliveryAdminDto } from '../dtos/InteractionDeliveryAdminDto';
import type { InteractionTicketAdminDto } from '../dtos/InteractionTicketAdminDto';
import type { TelegramBotAdminDto } from '../dtos/TelegramBotAdminDto';
import { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import { InteractionError } from '../errors/InteractionError';
import { InteractionErrorInterceptor } from '../errors/InteractionHttpException';
import { iso, toDeliveryAdminDto } from '../mappers/InteractionMapper';
import { optionalDate, optionalString, parseAdminDisable, parseKind, parseReason, parseUserId, parseUuid } from '../pure/bodies';
import { OPERATOR_BOT_REF, userOfBotRef } from '../pure/telegramUpdate';
import { TelegramBotStateStore } from '../providers/telegram/TelegramBotStateStore';
import { TelegramChannelProvider } from '../providers/telegram/TelegramChannelProvider';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { InteractionTicketService } from '../services/InteractionTicketService';
import { adminActorOf } from './interactionRequest';

const KIND = /^[a-z][a-z0-9_]{1,15}$/;

/**
 * Administrators' routes (04 §11.2): `/api/v1/admin/interaction/*` (`AdminOnlyInterceptor`, then `RejectApiTokenInterceptor`:
 * an administrator's static API token is refused, 403 `API_TOKEN_NOT_ALLOWED`, C2). Metadata only: no address, URL, chat
 * id, Telegram id, endpoint, token nor any text of a notice or a question.
 */
@Controller('/api/v1/admin/interaction')
@UseInterceptors(AdminOnlyInterceptor, RejectApiTokenInterceptor, InteractionErrorInterceptor)
export class InteractionAdminController {
  constructor(
    private readonly channels: InteractionChannelService,
    private readonly tickets: InteractionTicketService,
    private readonly bots: TelegramBotStateStore,
    @InjectRepository(InteractionDeliveryEntity) private readonly deliveries: Repository<InteractionDeliveryEntity>,
    @Optional() private readonly telegram?: TelegramChannelProvider,
  ) {}

  @Get('channels')
  channelList(@Query('userId') userId?: string, @Query('kind') kind?: string): Promise<InteractionChannelAdminDto[]> {
    return this.channels.adminList({ userId: userId ? parseUserId(userId) : undefined, kind: optionalString(kind, KIND) });
  }

  @Patch('users/:userId/channels/:kind')
  async setAdminDisabled(@Req() req: Request, @Param('userId') userId: string, @Param('kind') kind: string, @Body() body: unknown): Promise<{ success: true }> {
    await this.channels.adminSetDisabled(adminActorOf(req), parseUserId(userId), parseKind(kind), parseAdminDisable(body));
    return { success: true };
  }

  @Get('telegram/bots')
  async telegramBots(): Promise<TelegramBotAdminDto[]> {
    const rows = await this.bots.all();
    const operator = rows.some((row) => row.id === OPERATOR_BOT_REF) && this.telegram ? await this.telegram.operator().catch(() => null) : null;
    const out: TelegramBotAdminDto[] = [];
    for (const row of rows) {
      const ownerUserId = userOfBotRef(row.id);
      const username = ownerUserId === null ? operator?.username ?? null : await this.userBotName(ownerUserId);
      out.push({
        ref: ownerUserId === null ? 'operator' : 'user',
        ownerUserId,
        botUsername: username,
        status: row.status,
        lastError: row.lastError,
        lastPollAt: iso(row.lastPollAt),
        received: row.receivedCount,
        ignored: row.ignoredCount,
        rejected: row.rejectedCount,
        sent: row.sentCount,
        dropped: row.droppedCount,
      });
    }
    return out;
  }

  private async userBotName(userId: number): Promise<string | null> {
    const row = await this.channels.rowOf(userId, 'telegram');
    return typeof row?.config?.botUsername === 'string' ? row.config.botUsername : null;
  }

  @Post('telegram/operator/check')
  @HttpCode(200)
  checkOperator(): Promise<{ ok: boolean; botUsername: string | null; code: string | null }> {
    if (!this.telegram) throw new InteractionError('KIND_DISABLED');
    return this.telegram.checkOperator();
  }

  @Get('deliveries')
  async deliveryList(@Query('userId') userId?: string, @Query('kind') kind?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string): Promise<InteractionDeliveryAdminDto[]> {
    const start = optionalDate(from);
    const end = optionalDate(to);
    const where: FindOptionsWhere<InteractionDeliveryEntity> = {
      ...(userId ? { userId: parseUserId(userId) } : {}),
      ...(kind ? { kind: optionalString(kind, /^[a-z][a-z0-9_]{1,15}$/) } : {}),
      ...(status ? { status: optionalString(status, /^(queued|sent|failed|skipped|duplicate)$/) } : {}),
      ...(start && end ? { createdAt: And(MoreThanOrEqual(start), LessThanOrEqual(end)) } : start ? { createdAt: MoreThanOrEqual(start) } : end ? { createdAt: LessThanOrEqual(end) } : {}),
    };
    const rows = await this.deliveries.find({ where, order: { createdAt: 'DESC' }, take: 500 });
    return rows.map(toDeliveryAdminDto);
  }

  @Get('tickets')
  ticketList(@Query('status') status?: string, @Query('source') source?: string): Promise<InteractionTicketAdminDto[]> {
    return this.tickets.adminList({ status: optionalString(status, /^(open|answered|expired|cancelled)$/), source: optionalString(source, /^[a-z0-9][a-z0-9_.-]{0,39}$/) });
  }

  @Post('tickets/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: unknown): Promise<{ cancelled: boolean }> {
    return { cancelled: await this.tickets.cancelById(parseUuid(id), `admin:${parseReason(body)}`) };
  }
}
