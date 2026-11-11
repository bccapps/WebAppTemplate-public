/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/dbErrors';
import { InteractionTicketCardEntity } from '../entities/InteractionTicketCardEntity';
import { newCardKey } from '../pure/telegramCallback';

/**
 * The cards of the reply channels (04 §6 `interaction_ticket_card`): created BEFORE the send (its random key goes into the
 * buttons), bound to where it was sent once the channel answers (the Telegram `message_id`), closed once (conditional
 * UPDATE `open → closed`). Exported for the app's own reply providers.
 */
@Injectable()
export class InteractionTicketCardStore {
  constructor(@InjectRepository(InteractionTicketCardEntity) private readonly cards: Repository<InteractionTicketCardEntity>) {}

  async open(input: { ticketId: string; userId: number; kind: string; binding: Record<string, string>; lang: string }): Promise<InteractionTicketCardEntity> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.cards.save(this.cards.create({ ...input, cardKey: newCardKey(), state: 'open', lang: input.lang.slice(0, 5) }));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('[interaction] could not draw a unique card key');
  }

  /** Completes the binding (message id known after the send). */
  async bind(cardId: string, binding: Record<string, string>): Promise<void> {
    await this.cards.update({ id: cardId }, { binding });
  }

  async findOpenByKey(cardKey: string): Promise<InteractionTicketCardEntity | null> {
    return this.cards.findOne({ where: { cardKey, state: 'open' } });
  }

  /** Closes one card; true when this call closed it. */
  async close(cardId: string): Promise<boolean> {
    const result = await this.cards.update({ id: cardId, state: 'open' }, { state: 'closed' });
    return (result.affected ?? 0) > 0;
  }

  /** Every card of a ticket this call closed (the others were closed already). */
  async closeAllOf(ticketId: string): Promise<InteractionTicketCardEntity[]> {
    const open = await this.cards.find({ where: { ticketId, state: 'open' } });
    const closed: InteractionTicketCardEntity[] = [];
    for (const card of open) if (await this.close(card.id)) closed.push(card);
    return closed;
  }

  async deleteForTickets(ticketIds: string[]): Promise<void> {
    if (ticketIds.length > 0) await this.cards.delete({ ticketId: In(ticketIds) });
  }

  /** The open cards of one recipient of a ticket are closed (their buttons stop answering); true when one was. */
  async closeFor(ticketId: string, userId: number): Promise<boolean> {
    const result = await this.cards.update({ ticketId, userId, state: 'open' }, { state: 'closed' });
    return (result.affected ?? 0) > 0;
  }

  async forgetUser(userId: number): Promise<void> {
    await this.cards.update({ userId, state: 'open' }, { state: 'closed' });
  }
}
