/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { TRACE_LIMITS, TraceValue, sanitizeTraceFields, sanitizeTraceString } from './traceSanitizer';
import type { ValidationOutcome, ValidationSource } from './validationTrace';

/** Name of a check / trace point: lower-case words joined by `.`, `-` or `_` (`user.login.otp-required`), ≤ 100 chars. */
export const CHECK_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const CHECK_NAME_MAX_LENGTH = 100;

/** One JSONL line of `validation-<day>.jsonl` (format version `v: 1`). */
export interface TraceLine {
  v: 1;
  ts: string;
  app: string;
  env: string;
  check: string;
  outcome: ValidationOutcome;
  source?: ValidationSource;
  requestId?: string;
  corrId?: string;
  fields?: Record<string, TraceValue>;
  /** Summary line of the lines suppressed by sampling. */
  kind?: 'summary';
  suppressed?: number;
  windowMs?: number;
}

/** A trace refused before being written (bad check name or outcome). */
export class TraceRejectedError extends Error {}

export function isValidCheckName(check: unknown): check is string {
  return typeof check === 'string' && check.length <= CHECK_NAME_MAX_LENGTH && CHECK_NAME_PATTERN.test(check);
}

const OUTCOMES = new Set(['ok', 'violation', 'info']);

interface TraceLineInput {
  check: string;
  outcome: ValidationOutcome;
  source: ValidationSource;
  fields: unknown;
  env: Record<string, string | undefined>;
  app: string;
  now: number;
}

/** `requestId` / `corrId` given in the fields are promoted to the line (sanitized like any string). */
function promoteIds(fields: Record<string, TraceValue>, line: TraceLine): void {
  for (const name of ['requestId', 'corrId'] as const) {
    const value = fields[name];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    line[name] = sanitizeTraceString(String(value)).slice(0, 80);
    delete fields[name];
  }
}

/** Builds a sanitized trace line; past {@link TRACE_LIMITS.maxLineBytes} the fields are replaced by `{ _truncated: true }`. */
export function buildTraceLine(input: TraceLineInput): TraceLine {
  if (!isValidCheckName(input.check)) throw new TraceRejectedError('invalid check name');
  if (!OUTCOMES.has(input.outcome)) throw new TraceRejectedError('invalid outcome');
  const fields = sanitizeTraceFields(input.fields);
  const line: TraceLine = {
    v: 1,
    ts: new Date(input.now).toISOString(),
    app: input.app,
    env: input.env.APP_ENV?.trim().toLowerCase() ?? '',
    check: input.check,
    outcome: input.outcome,
    source: input.source,
  };
  promoteIds(fields, line);
  if (Object.keys(fields).length) line.fields = fields;
  if (Buffer.byteLength(JSON.stringify(line)) > TRACE_LIMITS.maxLineBytes) line.fields = { _truncated: true };
  return line;
}
