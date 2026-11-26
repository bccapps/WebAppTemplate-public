/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// `forgetTickets(source, correlationIds)` (2026-11-25): an app deleted what some of its questions were about; their CLOSED tickets go for
// good with everything that names them (question texts, recipients, cards, notices, deliveries), an open one is left. Run on SQLite and
// Postgres (`forget.sqlite.spec.ts`, `conformance.postgres.spec.ts`).

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { In } from 'typeorm';
import { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import { InteractionTicketCardEntity } from '../entities/InteractionTicketCardEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionTicketRecipientEntity } from '../entities/InteractionTicketRecipientEntity';
import { UserInteractionService } from '../services/UserInteractionService';
import type { InteractionAnswer } from '../types/interactionTypes';
import { expectCode, idle, linkOwnTelegram, question } from './interactionConformance.testkit';
import { createInteractionHarness, type Harness, type HarnessDatabase } from './interactionHarness';

export interface ForgetOptions {
  database: () => HarnessDatabase;
}

/** Rows of every table that names one of the tickets. */
async function rowsNaming(h: Harness, ticketIds: string[]): Promise<Record<string, number>> {
  const count = (entity: new () => object, where: object) => h.dataSource.getRepository(entity).count({ where });
  return {
    tickets: await count(InteractionTicketEntity, { id: In(ticketIds) }),
    recipients: await count(InteractionTicketRecipientEntity, { ticketId: In(ticketIds) }),
    cards: await count(InteractionTicketCardEntity, { ticketId: In(ticketIds) }),
    notices: await count(InteractionNoticeEntity, { ticketId: In(ticketIds) }),
    deliveries: await count(InteractionDeliveryEntity, { ticketId: In(ticketIds) }),
  };
}

const NONE = { tickets: 0, recipients: 0, cards: 0, notices: 0, deliveries: 0 };

export function describeInteractionForget(label: string, options: ForgetOptions): void {
  describe(`interaction forgetTickets — ${label}`, () => {
    let h: Harness;
    let handled: InteractionAnswer[];

    beforeEach(async () => {
      h = await createInteractionHarness({ database: options.database(), config: { interaction_enabledKinds: ['telegram'], interaction_providerTimeoutMs: 1000 } });
      for (const id of [1, 2]) h.directory.add(id);
      handled = [];
      h.get(UserInteractionService).onAnswer('test.approval', async (answer) => void handled.push(answer));
    });

    afterEach(async () => {
      await idle(h).catch(() => undefined);
      await h.close();
    });

    it('forgets closed tickets with everything that names them; an open one and another source stay; idempotent', async () => {
      const service = h.get(UserInteractionService);
      await linkOwnTelegram(h, 1);
      const closed = await service.ask([1, 2], question({ correlationId: 'gone-1' }));
      const open = await service.ask(1, question({ correlationId: 'gone-2' }));
      const other = await service.ask(1, question({ source: 'others', correlationId: 'gone-1' }));
      await idle(h);
      expect(await service.cancel('tests', 'gone-1', 'deleted')).toBe(true);
      await idle(h);
      expect(handled.map((answer) => [answer.ticketId, answer.status])).toEqual([[closed.id, 'cancelled']]);
      const before = await rowsNaming(h, [closed.id]);
      expect(before.tickets).toBe(1);
      expect(before.recipients).toBe(2);
      expect(before.notices).toBeGreaterThan(0);
      expect(before.cards).toBeGreaterThan(0);

      await expect(service.forgetTickets('tests', ['gone-1', 'gone-2', 'unknown'])).resolves.toEqual({ forgotten: 1, open: 1 });
      expect(await rowsNaming(h, [closed.id])).toEqual(NONE);
      expect((await rowsNaming(h, [open.id])).tickets).toBe(1);
      expect((await rowsNaming(h, [other.id])).tickets).toBe(1);
      expect((await h.get(UserInteractionService).getTicket(open.id))?.status).toBe('open');

      await expect(service.forgetTickets('tests', ['gone-1'])).resolves.toEqual({ forgotten: 0, open: 0 });
      await expect(service.forgetTickets('tests', [])).resolves.toEqual({ forgotten: 0, open: 0 });
    });

    it('a closed ticket whose outcome is still being handed over is forgotten; the hand-over then finds nothing', async () => {
      const service = h.get(UserInteractionService);
      const ticket = await service.ask(1, question({ correlationId: 'racing' }));
      await idle(h);
      expect(await service.cancel('tests', 'racing', 'deleted')).toBe(true);
      await expect(service.forgetTickets('tests', ['racing'])).resolves.toEqual({ forgotten: 1, open: 0 });
      await idle(h);
      expect(await rowsNaming(h, [ticket.id])).toEqual(NONE);
    });

    it('refuses a malformed source (a programming error, never silently ignored)', async () => {
      await expectCode(h.get(UserInteractionService).forgetTickets('Not A Source', ['x']), 'INVALID_INPUT');
    });
  });
}
