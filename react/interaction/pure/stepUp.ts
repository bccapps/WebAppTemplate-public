/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// Answering a question that needs a recent proof of identity (04 §21): the server tells which methods the account
// has only in its `STEP_UP_REQUIRED { methods, purpose }` rejection, so the first attempt goes without a proof and the
// registered handler (lot S) is asked once, with the server's methods, before the answer is sent again.

import type { InteractionApiError } from '../types/interactionTypes';

/** A pluggable step-up (lot S, `user` module): returns a proof id bound to `purpose`, or null when the user gave up. */
export type InteractionStepUpHandler = (request: { ticketId: string; purpose: string; methods: string[] }) => Promise<string | null>;

export interface StepUpRequest {
  methods: string[];
  purpose: string | null;
}

/** The methods and purpose carried by a `STEP_UP_REQUIRED` rejection, null for any other failure. */
export function stepUpRequestOf(error: unknown): StepUpRequest | null {
  const failure = error as Partial<InteractionApiError> | null;
  if (!failure || failure.code !== 'STEP_UP_REQUIRED') return null;
  const details = failure.details ?? {};
  const methods = Array.isArray(details.methods) ? details.methods.filter((method): method is string => typeof method === 'string') : [];
  return { methods, purpose: typeof details.purpose === 'string' && details.purpose ? details.purpose : null };
}

export interface AnswerFlowInput {
  ticketId: string;
  /** The purpose of the ticket, when the rejection does not carry one. */
  fallbackPurpose: string | null;
  /** A proof the caller already holds (no handler is asked then). */
  proof?: string;
  handler: InteractionStepUpHandler | null;
  send: (proof?: string) => Promise<unknown>;
}

/**
 * Sends the answer; on `STEP_UP_REQUIRED` asks the handler (with the server's methods) and sends it again with the proof.
 * `cancelled`: the user gave up the step-up (nothing sent, no error). Any other failure, a missing handler and a
 * rejected proof rethrow the API error.
 */
export async function answerWithStepUp(input: AnswerFlowInput): Promise<'answered' | 'cancelled'> {
  try {
    await input.send(input.proof);
    return 'answered';
  } catch (caught) {
    const request = input.proof ? null : stepUpRequestOf(caught);
    const purpose = request?.purpose ?? input.fallbackPurpose;
    if (!request || !input.handler || !purpose) throw caught;
    const proof = await input.handler({ ticketId: input.ticketId, purpose, methods: request.methods });
    if (!proof) return 'cancelled';
    await input.send(proof);
    return 'answered';
  }
}
