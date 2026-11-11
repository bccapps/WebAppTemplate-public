/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Error taxonomy (contract 04 §12). The internal error is `InteractionError(code, details)`; routes turn it into the
// common `AppException` body `{ code, message, details? }`. The message is a fixed English sentence per code: never a
// value of the request (it may be a target or a secret).

/** HTTP codes (04 §12.1). */
export type InteractionHttpErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'VERIFICATION_FAILED'
  | 'CHANNEL_NOT_ALLOWED'
  | 'STEP_UP_REQUIRED'
  | 'NOT_FOUND'
  | 'ADMIN_DISABLED'
  | 'KIND_DISABLED'
  | 'NOT_CONFIGURED'
  | 'BOT_IN_USE'
  | 'ALREADY_ANSWERED'
  | 'CANCELLED'
  | 'EMAIL_UNAVAILABLE'
  | 'EXPIRED'
  | 'ROUTE_REQUIRED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

/** Service codes thrown to the app (04 §12.2), plus the secret store's failure. */
export type InteractionServiceErrorCode =
  | 'INTERACTION_NO_HUMAN'
  | 'INVALID_QUESTION'
  | 'UNKNOWN_QUESTION_KIND'
  | 'STEP_UP_UNAVAILABLE'
  | 'INVALID_NOTICE'
  | 'SECRET_UNREADABLE';

export type InteractionErrorCode = InteractionHttpErrorCode | InteractionServiceErrorCode;

interface ErrorSpec {
  status: number;
  message: string;
}

export const INTERACTION_ERRORS: Record<InteractionErrorCode, ErrorSpec> = {
  INVALID_INPUT: { status: 400, message: 'Invalid input' },
  INVALID_CONFIG: { status: 400, message: 'Invalid channel configuration' },
  VERIFICATION_FAILED: { status: 400, message: 'Verification failed' },
  CHANNEL_NOT_ALLOWED: { status: 403, message: 'This question cannot be answered from this channel' },
  STEP_UP_REQUIRED: { status: 403, message: 'A recent proof of identity is required' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  ADMIN_DISABLED: { status: 409, message: 'This channel was disabled by an administrator' },
  KIND_DISABLED: { status: 409, message: 'This channel kind is not available' },
  NOT_CONFIGURED: { status: 409, message: 'This channel is not configured' },
  BOT_IN_USE: { status: 409, message: 'This bot is already used on this app' },
  ALREADY_ANSWERED: { status: 409, message: 'This question was already answered' },
  CANCELLED: { status: 409, message: 'This question was cancelled' },
  EMAIL_UNAVAILABLE: { status: 409, message: 'E-mail is not available' },
  EXPIRED: { status: 410, message: 'This question has expired' },
  ROUTE_REQUIRED: { status: 422, message: 'Approval and security notices need at least one channel' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  UPSTREAM_UNAVAILABLE: { status: 502, message: 'The channel service is unreachable' },
  // Any failure that is not the module's own (a database error…), as a route answers it: never its message (review F6).
  INTERNAL: { status: 500, message: 'Internal error' },
  INTERACTION_NO_HUMAN: { status: 400, message: 'No active human recipient' },
  INVALID_QUESTION: { status: 400, message: 'Invalid question' },
  UNKNOWN_QUESTION_KIND: { status: 500, message: 'No handler for this question kind' },
  STEP_UP_UNAVAILABLE: { status: 500, message: 'No step-up provider is configured' },
  INVALID_NOTICE: { status: 400, message: 'Invalid notice' },
  SECRET_UNREADABLE: { status: 500, message: 'A stored secret cannot be read' },
};

/** Details carry codes, kinds, counts and dates only: never a target, a text or a secret. */
export type InteractionErrorDetails = Record<string, string | number | boolean | null | string[] | Date>;

export class InteractionError extends Error {
  constructor(
    readonly code: InteractionErrorCode,
    readonly details?: InteractionErrorDetails,
    /** `RATE_LIMITED`: seconds before a retry (`Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'InteractionError';
  }

  get status(): number {
    return INTERACTION_ERRORS[this.code].status;
  }
}

export function isInteractionError(error: unknown, code?: InteractionErrorCode): error is InteractionError {
  return error instanceof InteractionError && (code === undefined || error.code === code);
}
