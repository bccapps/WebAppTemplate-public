/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// C2 (AgentHub): answer gates (`onAnswer(kind, handler, { gate })`). A ticket is never `answered` when the app refused the
// answer; the first answer wins in both directions; no answer is applied twice; a step-up proof is never spent by a refusal
// that comes before any effect. Run on SQLite (`gate.sqlite.spec.ts`) and Postgres (`conformance.postgres.spec.ts`).

import { afterEach, describe, expect, it } from '@jest/globals';
import { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import { InteractionError, isInteractionError } from '../errors/InteractionError';
import { InteractionChannelService } from '../services/InteractionChannelService';
import { APPLY_CLAIM, gateRefusal } from '../services/InteractionTicketService';
import { InteractionMaintenanceService } from '../services/InteractionMaintenanceService';
import { UserInteractionService } from '../services/UserInteractionService';
import type { InteractionAnswer, InteractionAnswerGate, PendingAnswer } from '../types/interactionTypes';
import { stepUpPurposeOf } from '../types/ports';
import { http, idle, owner, question } from './interactionConformance.testkit';
import { GatedStepUp, InAppReplyProvider } from './interactionHardening.testkit';
import { createInteractionHarness, type Harness, type HarnessDatabase } from './interactionHarness';

export interface GateOptions {
  database: () => HarnessDatabase;
}

const codeOf = (error: unknown): string => (isInteractionError(error) ? error.code : `raw:${(error as Error)?.message ?? String(error)}`);

/** A gate whose verdicts the test sets: `checkRefusal` / `applyRefusal` (an error to throw), `applyHold` (a promise `apply` waits on). */
class TestGate implements InteractionAnswerGate {
  checks: PendingAnswer[] = [];
  applied: PendingAnswer[] = [];
  checkRefusal: unknown = null;
  applyRefusal: unknown = null;
  applyHold: Promise<void> | null = null;
  timeoutMs = 2_000;
  isUncertain(error: unknown): boolean {
    return (error as { uncertain?: unknown } | null)?.uncertain === true;
  }
  async check(answer: PendingAnswer): Promise<void> {
    this.checks.push(answer);
    if (this.checkRefusal) throw this.checkRefusal;
  }
  async apply(answer: PendingAnswer): Promise<void> {
    if (this.applyHold) await this.applyHold;
    if (this.applyRefusal) throw this.applyRefusal;
    this.applied.push(answer);
  }
}

export function describeInteractionGate(label: string, options: GateOptions): void {
  describe(`interaction answer gates (C2) — ${label}`, () => {
    let h: Harness;
    let gate: TestGate;
    let handled: InteractionAnswer[];

    async function make(): Promise<Harness> {
      const created = await createInteractionHarness({ database: options.database(), config: { interaction_enabledKinds: ['hubchat'], interaction_providerTimeoutMs: 1000 }, providers: [InAppReplyProvider], stepUp: GatedStepUp });
      for (const id of [1, 2]) created.directory.add(id);
      gate = new TestGate();
      handled = [];
      created.get(UserInteractionService).onAnswer('test.approval', async (answer) => void handled.push(answer), { source: 'tests', gate });
      for (const id of [1, 2]) await created.get(InteractionChannelService).configure(owner(id), 'hubchat', {});
      return created;
    }

    afterEach(async () => {
      await idle(h).catch(() => undefined);
      await h.close();
    });

    const row = (id: string) => h.dataSource.getRepository(InteractionTicketEntity).findOneByOrFail({ id });
    const ask = (extra: Parameters<typeof question>[0] = {}) => h.get(UserInteractionService).ask([1, 2], question({ source: 'tests', answerableFrom: ['inapp', 'hubchat'], ...extra }));
    const answerInApp = (ticketId: string, userId = 1, body: Record<string, unknown> = { actionId: 'approve' }) => http(h).post(`/api/v1/interaction/me/tickets/${ticketId}/answer`).set('Authorization', `Bearer user-${userId}`).send(body);
    const viaProvider = (ticketId: string, extra: { stepUpProof?: string; userId?: number } = {}) =>
      h.get(UserInteractionService).answerFromProvider(h.get(InAppReplyProvider), { ticketId, userId: extra.userId ?? 1, actionId: 'approve', stepUpProof: extra.stepUpProof ?? null });

    it('applies the answer, then answers the ticket; the handler gets it once; a replay changes nothing', async () => {
      h = await make();
      const ticket = await ask();
      const res = await answerInApp(ticket.id);
      expect(res.status).toBe(200);
      expect(gate.checks.map((c) => c.correlationId)).toEqual([ticket.correlationId]);
      expect(gate.applied).toEqual([{ ticketId: ticket.id, kind: 'test.approval', source: 'tests', correlationId: ticket.correlationId, actionId: 'approve', via: 'inapp', answeredBy: 1, freshProof: false }]);
      expect(await row(ticket.id)).toMatchObject({ status: 'answered', answerAction: 'approve', answeredVia: 'inapp', answeredBy: 1 });
      await idle(h);
      expect(handled).toEqual([expect.objectContaining({ ticketId: ticket.id, status: 'answered', actionId: 'approve' })]);
      const replay = await answerInApp(ticket.id);
      expect([replay.status, replay.body.code]).toEqual([409, 'ALREADY_ANSWERED']);
      await expect(viaProvider(ticket.id)).rejects.toMatchObject({ code: 'ALREADY_ANSWERED' });
      expect(gate.applied).toHaveLength(1);
    });

    it('a refusal of check or of apply never leaves the ticket answered: it stays open, unclaimed, answerable', async () => {
      h = await make();
      const ticket = await ask();
      gate.checkRefusal = Object.assign(new Error('the dialog is gone'), { code: 'ALREADY_RESOLVED' });
      const byCheck = await answerInApp(ticket.id);
      expect([byCheck.status, byCheck.body.code, byCheck.body.details]).toEqual([409, 'ANSWER_REFUSED', { reason: 'ALREADY_RESOLVED' }]);
      expect(byCheck.body.message).not.toContain('dialog');
      expect(await row(ticket.id)).toMatchObject({ status: 'open', dispatchStatus: 'none' });
      gate.checkRefusal = null;
      gate.applyRefusal = Object.assign(new Error('runner gone'), { code: 'RUNNER_OFFLINE' });
      await expect(viaProvider(ticket.id)).rejects.toMatchObject({ code: 'ANSWER_REFUSED', details: { reason: 'RUNNER_OFFLINE' } });
      expect(await row(ticket.id)).toMatchObject({ status: 'open', dispatchStatus: 'none', answeredBy: null });
      // An InteractionError of the gate reaches the answerer as is; anything without a code is ERROR, never its message.
      gate.applyRefusal = new InteractionError('CANCELLED');
      await expect(viaProvider(ticket.id)).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(gateRefusal(new Error('secret text'))).toMatchObject({ code: 'ANSWER_REFUSED', details: { reason: 'ERROR' } });
      gate.applyRefusal = null;
      expect((await answerInApp(ticket.id, 2)).status).toBe(200);
      expect(await row(ticket.id)).toMatchObject({ status: 'answered', answeredBy: 2 });
      await idle(h);
      expect(handled).toHaveLength(1);
      expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { type: 'interaction.answered_elsewhere' } })).toBe(0);
    });

    it('a step-up proof is not spent by a refusal before any effect, and is single use', async () => {
      h = await make();
      const stepUp = h.get(GatedStepUp);
      const ticket = await ask({ freshProof: true });
      const proof = `ok:${stepUpPurposeOf(ticket.id)}:1`;
      gate.checkRefusal = Object.assign(new Error('x'), { code: 'FORBIDDEN' });
      await expect(viaProvider(ticket.id, { stepUpProof: proof })).rejects.toMatchObject({ code: 'ANSWER_REFUSED' });
      expect(stepUp.calls).toEqual([]);
      gate.checkRefusal = null;
      await expect(viaProvider(ticket.id)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(gate.applied).toHaveLength(0);
      await expect(viaProvider(ticket.id, { stepUpProof: 'ok:interaction.ticket:other:1' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(await row(ticket.id)).toMatchObject({ status: 'open', dispatchStatus: 'none' });
      expect((await viaProvider(ticket.id, { stepUpProof: proof })).status).toBe('answered');
      expect(stepUp.consumed).toEqual([proof]);
      expect(gate.applied).toHaveLength(1);
      // The gate is told the proof was required: `check` before it is spent, `apply` after.
      expect(gate.checks.every((answer) => answer.freshProof)).toBe(true);
      expect(gate.applied[0].freshProof).toBe(true);
    });

    it('two answers at once: one applies, the other waits then gets ALREADY_ANSWERED — never two effects', async () => {
      h = await make();
      const ticket = await ask();
      let release: () => void = () => undefined;
      gate.applyHold = new Promise<void>((resolve) => (release = resolve));
      const first = answerInApp(ticket.id, 1).then((res) => res);
      await waitFor(async () => (await row(ticket.id)).dispatchStatus === APPLY_CLAIM);
      const second = viaProvider(ticket.id, { userId: 2 }).then(() => 'answered', codeOf);
      setTimeout(release, 50);
      expect((await first).status).toBe(200);
      expect(await second).toBe('ALREADY_ANSWERED');
      expect(gate.applied).toHaveLength(1);
    });

    it('a claim held longer than the wait: the other answer gets IN_PROGRESS; cancel and the sweep leave a live claim alone', async () => {
      h = await make();
      gate.timeoutMs = 15_000;
      const ticket = await ask();
      let release: () => void = () => undefined;
      gate.applyHold = new Promise<void>((resolve) => (release = resolve));
      const first = answerInApp(ticket.id, 1).then((res) => res);
      await waitFor(async () => (await row(ticket.id)).dispatchStatus === APPLY_CLAIM);
      const second = await answerInApp(ticket.id, 2);
      expect([second.status, second.body.code]).toEqual([409, 'IN_PROGRESS']);
      expect(await h.get(UserInteractionService).cancel('tests', ticket.correlationId, 'resolved')).toBe(false);
      expect(await h.get(UserInteractionService).openTickets('tests')).toEqual([{ ticketId: ticket.id, correlationId: ticket.correlationId, applying: true, recipients: [1, 2], freshProof: false }]);
      expect(await h.get(UserInteractionService).openTickets('tests', { correlationId: 'another' })).toEqual([]);
      // Even past its expiry, a ticket being answered is not expired by the sweep, and the answer is confirmed.
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { expiresAt: new Date(Date.now() - 1000) });
      await h.get(InteractionMaintenanceService).tick();
      expect((await row(ticket.id)).status).toBe('open');
      release();
      expect((await first).status).toBe(200);
      expect((await row(ticket.id)).status).toBe('answered');
      expect(await h.get(UserInteractionService).openTickets('tests')).toEqual([]);
    }, 20_000);

    it('a timed-out apply keeps the claim until it lapses; a crashed claimant is taken over; the app sees its open tickets', async () => {
      h = await make();
      gate.timeoutMs = 50;
      const ticket = await ask();
      gate.applyHold = new Promise<void>(() => undefined);
      const timedOut = await answerInApp(ticket.id, 1);
      expect([timedOut.status, timedOut.body.code, timedOut.body.details]).toEqual([409, 'ANSWER_REFUSED', { reason: 'TIMEOUT' }]);
      const held = await row(ticket.id);
      expect(held).toMatchObject({ status: 'open', dispatchStatus: APPLY_CLAIM });
      expect(held.dispatchNextAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
      // A crash: the claimant is gone; its claim lapses (simulated), then the next answer takes the ticket over.
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: ticket.id }, { dispatchNextAt: new Date(Date.now() - 1) });
      expect(await h.get(UserInteractionService).openTickets('tests')).toEqual([{ ticketId: ticket.id, correlationId: ticket.correlationId, applying: false, recipients: [1, 2], freshProof: false }]);
      gate.applyHold = null;
      expect((await answerInApp(ticket.id, 2)).status).toBe(200);
      expect(await row(ticket.id)).toMatchObject({ status: 'answered', answeredBy: 2 });
      // A lapsed claim does not hold a cancellation either.
      const other = await ask();
      await h.dataSource.getRepository(InteractionTicketEntity).update({ id: other.id }, { dispatchStatus: APPLY_CLAIM, dispatchNextAt: new Date(Date.now() - 1) });
      expect(await h.get(UserInteractionService).cancel('tests', other.correlationId, 'resolved')).toBe(true);
    });

    it('requireFreshProof: an open ticket comes to need a proof — an answer without one is refused, then one with a proof goes', async () => {
      h = await make();
      const ticket = await ask();
      expect(await h.get(UserInteractionService).requireFreshProof('tests', ticket.correlationId)).toBe(true);
      expect(await h.get(UserInteractionService).requireFreshProof('tests', ticket.correlationId)).toBe(false);
      expect((await row(ticket.id)).freshProof).toBe(true);
      await expect(viaProvider(ticket.id)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(gate.applied).toHaveLength(0);
      expect((await viaProvider(ticket.id, { stepUpProof: `ok:${stepUpPurposeOf(ticket.id)}:1` })).status).toBe('answered');
    });

    it('an apply error the app calls uncertain (its effect may still land) keeps the claim like a timeout: no second answer meanwhile', async () => {
      h = await make();
      const ticket = await ask();
      gate.applyRefusal = Object.assign(new Error('runner slow'), { code: 'RUNNER_TIMEOUT', uncertain: true });
      const uncertain = await answerInApp(ticket.id, 1);
      expect([uncertain.status, uncertain.body.code, uncertain.body.details]).toEqual([409, 'ANSWER_REFUSED', { reason: 'RUNNER_TIMEOUT' }]);
      expect(await row(ticket.id)).toMatchObject({ status: 'open', dispatchStatus: APPLY_CLAIM });
      gate.applyRefusal = null;
      expect((await answerInApp(ticket.id, 2)).body.code).toBe('IN_PROGRESS');
      expect(gate.applied).toHaveLength(0);
    });

    it('withdraws a recipient: the ticket, its notices and answers are gone for them; nobody left cancels it', async () => {
      h = await make();
      const ticket = await ask();
      expect((await http(h).get(`/api/v1/interaction/me/tickets/${ticket.id}`).set('Authorization', 'Bearer user-1')).status).toBe(200);
      expect(await h.get(UserInteractionService).revokeRecipient('tests', ticket.correlationId, 1, 'access_lost')).toBe(true);
      expect(await h.get(UserInteractionService).revokeRecipient('tests', ticket.correlationId, 1, 'access_lost')).toBe(false);
      expect((await http(h).get(`/api/v1/interaction/me/tickets/${ticket.id}`).set('Authorization', 'Bearer user-1')).status).toBe(404);
      expect((await http(h).get('/api/v1/interaction/me/inbox').set('Authorization', 'Bearer user-1')).body.tickets).toEqual([]);
      expect(await h.dataSource.getRepository(InteractionNoticeEntity).count({ where: { userId: 1, ticketId: ticket.id } })).toBe(0);
      expect((await answerInApp(ticket.id, 1)).status).toBe(404);
      expect(gate.checks).toHaveLength(0);
      expect((await row(ticket.id)).status).toBe('open');
      expect(await h.get(UserInteractionService).revokeRecipient('tests', ticket.correlationId, 2, 'access_lost')).toBe(true);
      expect(await row(ticket.id)).toMatchObject({ status: 'cancelled', cancelReason: 'access_lost' });
    });

    it('refuses an invalid gate at registration', async () => {
      h = await make();
      const api = h.get(UserInteractionService);
      expect(() => api.onAnswer('test.other', async () => undefined, { gate: {} as InteractionAnswerGate })).toThrow(/apply/);
      expect(() => api.onAnswer('test.other', async () => undefined, { gate: { apply: async () => undefined, timeoutMs: 0 } })).toThrow(/timeoutMs/);
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
