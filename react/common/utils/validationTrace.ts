/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { httpService } from '../core/http/HttpService';
import { configurationService } from '../services/ConfigurationService';

/** Outcome of a control: `ok` = behaved as specified, `violation` = non-conformity observed, `info` = context only. */
export type ValidationOutcome = 'ok' | 'violation' | 'info';
type TraceScalar = string | number | boolean | null;
export type ValidationTraceFields = Record<string, TraceScalar | TraceScalar[]>;

export interface ValidationTraceOptions {
  /** Trace sent before sign-in: goes to the unauthenticated route, accepted only for checks marked `preLogin`. */
  preLogin?: boolean;
}

/** `VITE_APP_ENV` values with which traces are sent (`production`, anything else or nothing: never). */
const ACTIVE_ENVS = new Set(['dev', 'preprod']);
const MAX_FIELDS = 24;
const MAX_STRING = 200;
/** Same name fragments as the back (`traceSanitizer.ts`): such fields are not even sent. */
const SENSITIVE = /secret|token|password|passwd|pwd|phrase|key|auth|bearer|cookie|session|credential|proof|code|otp|signature|seed|mnemonic|salt|jwt|cipher|recovery|pin$/i;

/** Whether this build sends validation traces (`VITE_APP_ENV` is `dev` or `preprod`; fail-closed otherwise). */
export function isValidationTraceActive(env: unknown = import.meta.env.VITE_APP_ENV): boolean {
  return typeof env === 'string' && ACTIVE_ENVS.has(env.trim().toLowerCase());
}

function prefilter(fields: Record<string, unknown> | undefined): ValidationTraceFields {
  const out: ValidationTraceFields = {};
  for (const [key, value] of Object.entries(fields ?? {}).slice(0, MAX_FIELDS)) {
    if (SENSITIVE.test(key.replace(/[^a-z0-9]/gi, '')) && !/^(status|error|http|reason|country|currency)code$/i.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

const ignore = () => undefined;

/**
 * Sends one validation trace to the back (`POST /api/v1/validation/trace`, or `/trace/public` with `preLogin`), which
 * accepts only the traces declared with `"sources": ["front"]` in a module's `validation/checks.json` and sanitizes them.
 * Inert in production: nothing is evaluated (pass `fields` as a function when computing them costs anything) nor sent.
 * Never throws, never awaits, never reports a failure to the user. Never pass a secret or raw personal data.
 */
export function validationTrace(
  check: string,
  outcome: ValidationOutcome,
  fields?: Record<string, unknown> | (() => Record<string, unknown>),
  options: ValidationTraceOptions = {},
): void {
  if (!isValidationTraceActive()) return;
  try {
    const raw = typeof fields === 'function' ? fields() : fields;
    const url = `${configurationService.getApiUrl('common')}/validation/trace${options.preLogin ? '/public' : ''}`;
    httpService.post(url, { check, outcome, fields: prefilter(raw) }).then(ignore).fail(ignore).error(ignore).notAuthorized(ignore);
  } catch {
    /* a trace never breaks the page */
  }
}
