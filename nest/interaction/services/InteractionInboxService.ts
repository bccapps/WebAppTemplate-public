/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import type { InboxDto } from '../dtos/InboxDto';
import type { InteractionNoticeDto } from '../dtos/InteractionNoticeDto';
import { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionTicketRecipientEntity } from '../entities/InteractionTicketRecipientEntity';
import { InteractionError } from '../errors/InteractionError';
import { toNoticeDto, toTicketDto } from '../mappers/InteractionMapper';
import type { CleanNotice } from '../pure/validation';
import { INTERACTION_REALTIME, type InteractionRealtimePort } from '../types/ports';

const INBOX_NOTICES_MAX = 100;

/**
 * The in-app inbox (04 §5 `inapp`, §11.1): notices of a user and the open tickets they must answer. A notice tied to a
 * ticket is represented by the ticket (not counted twice). Every read is scoped to the session user; a notice or a
 * ticket of someone else is `NOT_FOUND`, exactly like an unknown id.
 */
@Injectable()
export class InteractionInboxService {
  constructor(
    @InjectRepository(InteractionNoticeEntity) private readonly notices: Repository<InteractionNoticeEntity>,
    @InjectRepository(InteractionTicketEntity) private readonly tickets: Repository<InteractionTicketEntity>,
    @Inject(INTERACTION_REALTIME) private readonly realtime: InteractionRealtimePort,
  ) {}

  /** Writes an in-app notice and announces it (`notice`, id only). */
  async write(userId: number, notice: CleanNotice, ticketId: string | null): Promise<string> {
    const row = await this.notices.save(
      this.notices.create({
        userId,
        type: notice.type,
        source: notice.source,
        category: notice.category,
        priority: notice.priority,
        title: notice.title,
        body: notice.body,
        url: notice.url,
        data: notice.data,
        ticketId,
        readAt: null,
      }),
    );
    this.realtime.publish(userId, { type: 'notice', id: row.id });
    return row.id;
  }

  async inbox(userId: number, now = new Date()): Promise<InboxDto> {
    const open = await this.openTicketsOf(userId, now);
    const notices = await this.notices.find({ where: { userId, readAt: IsNull(), ticketId: IsNull() }, order: { createdAt: 'DESC' }, take: INBOX_NOTICES_MAX });
    const unreadNotices = await this.notices.count({ where: { userId, readAt: IsNull(), ticketId: IsNull() } });
    return { tickets: open.map((row) => toTicketDto(row, userId)), notices: notices.map(toNoticeDto), unread: open.length + unreadNotices };
  }

  /** Open, unexpired tickets of which `userId` is a recipient (newest first, 50 at most). */
  private async openTicketsOf(userId: number, now: Date): Promise<InteractionTicketEntity[]> {
    return this.tickets
      .createQueryBuilder('t')
      .innerJoin(InteractionTicketRecipientEntity, 'r', 'r.ticketId = t.id')
      .where('r.userId = :userId', { userId })
      .andWhere('t.status = :status', { status: 'open' })
      .andWhere('t.expiresAt > :now', { now })
      .orderBy('t.createdAt', 'DESC')
      .limit(50)
      .getMany();
  }

  async notice(userId: number, id: string): Promise<InteractionNoticeDto> {
    const row = await this.notices.findOne({ where: { id, userId } });
    if (!row) throw new InteractionError('NOT_FOUND');
    return toNoticeDto(row);
  }

  async markRead(userId: number, ids: string[] | 'all'): Promise<void> {
    const now = new Date();
    if (ids === 'all') await this.notices.update({ userId, readAt: IsNull() }, { readAt: now });
    else await this.notices.update({ userId, id: In(ids), readAt: IsNull() }, { readAt: now });
    this.realtime.publish(userId, { type: 'notice', data: { read: '1' } });
  }

  /** The ticket notices of a closed ticket are read (the ticket left the inbox). */
  async closeTicketNotices(ticketId: string): Promise<void> {
    await this.notices.update({ ticketId, readAt: IsNull() }, { readAt: new Date() });
  }

  async forgetUser(userId: number): Promise<void> {
    await this.notices.delete({ userId });
  }

  /** A recipient withdrawn from a ticket (C2): their notices of it go (the question's texts with them). */
  async forgetTicketFor(userId: number, ticketId: string): Promise<void> {
    await this.notices.delete({ userId, ticketId });
  }

  async purge(before: Date): Promise<void> {
    await this.notices.delete({ createdAt: LessThan(before) });
  }
}
