/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import { TraceLine, TraceRejectedError, buildTraceLine, isValidCheckName } from './traceLine';
import { TraceFields } from './traceSanitizer';
import { TraceFileSink, resolveValidationLogDir } from './traceFileSink';

/** Outcome of a control: `ok` = behaved as specified, `violation` = non-conformity observed, `info` = context only. */
export type ValidationOutcome = 'ok' | 'violation' | 'info';
export const VALIDATION_OUTCOMES: readonly ValidationOutcome[] = ['ok', 'violation', 'info'];
/** Where a trace was emitted. */
export type ValidationSource = 'back' | 'front';
/** Fields of a trace, or a function computing them: called only when the trace is really written (never in production). */
export type LazyTraceFields = TraceFields | (() => TraceFields);

/** `APP_ENV` values with which traces are active. Anything else, or no `APP_ENV`, keeps them off (fail-closed). */
export const VALIDATION_TRACE_ENVS: readonly string[] = ['dev', 'preprod'];

type Env = Record<string, string | undefined>;

export interface ValidationTraceOptions {
  /** Environment read once (default `process.env`). */
  env?: Env;
  /** Clock (tests). */
  now?: () => number;
  /** Line writer (tests); default: the daily JSONL file. */
  sink?: { write(line: string): boolean };
  /** Nest logger output (tests); default `new Logger('validation').log`. */
  log?: (line: string) => void;
}

/**
 * Whether traces are active for `env`: `APP_ENV` ∈ {dev, preprod}, `VALIDATION_TRACE` absent or `on` (`off` disables,
 * any other value disables: fail-closed), and not under a test runner (`NODE_ENV=test`) unless `VALIDATION_TRACE=on`.
 */
export function isValidationTraceEnabledFor(env: Env): boolean {
  const appEnv = env.APP_ENV?.trim().toLowerCase() ?? '';
  if (!VALIDATION_TRACE_ENVS.includes(appEnv)) return false;
  const flag = env.VALIDATION_TRACE?.trim().toLowerCase() ?? '';
  if (flag !== '' && flag !== 'on') return false;
  return env.NODE_ENV !== 'test' || flag === 'on';
}

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

interface SamplingWindow {
  start: number;
  written: number;
  suppressed: number;
  timer: NodeJS.Timeout | null;
}

/** Distinct (check, outcome) pairs followed for sampling; beyond, lines are only counted under `validation.trace.overflow`. */
const MAX_SAMPLING_KEYS = 1000;
const WINDOW_MS = 60_000;

interface TraceRuntime {
  enabled: boolean;
  env: Env;
  now: () => number;
  sink: { write(line: string): boolean };
  log: (line: string) => void;
  perMinute: number;
  windows: Map<string, SamplingWindow>;
  warned: Set<string>;
}

let runtime: TraceRuntime | null = null;

function createRuntime(options: ValidationTraceOptions): TraceRuntime {
  const env = options.env ?? process.env;
  const enabled = isValidationTraceEnabledFor(env);
  const logger = new Logger('validation');
  const warned = new Set<string>();
  const warnOnce = (reason: string) => {
    if (!warned.has(`sink:${reason}`)) logger.warn(`validation trace file disabled (${reason})`);
    warned.add(`sink:${reason}`);
  };
  const now = options.now ?? Date.now;
  const sink =
    options.sink ??
    (enabled
      ? new TraceFileSink({
          dir: resolveValidationLogDir(env),
          maxBytes: intSetting(env, 'VALIDATION_TRACE_MAX_MB', 20, 1, 500) * 1024 * 1024,
          retentionDays: intSetting(env, 'VALIDATION_TRACE_RETENTION_DAYS', 7, 1, 90),
          now,
          onFailure: warnOnce,
        })
      : { write: () => false });
  const log = options.log ?? ((line: string) => logger.log(line));
  return { enabled, env, now, sink, log, perMinute: intSetting(env, 'VALIDATION_TRACE_PER_MINUTE', 20, 1, 1000), windows: new Map(), warned };
}

function current(): TraceRuntime {
  if (!runtime) runtime = createRuntime({});
  return runtime;
}

/**
 * Re-reads the configuration (tests, or an app that loads its env after the first import). Flushes the pending
 * summaries of the previous configuration first.
 */
export function configureValidationTrace(options: ValidationTraceOptions = {}): void {
  flushValidationTrace();
  runtime = createRuntime(options);
}

/** Whether traces are active in this process (computed once from `process.env`). */
export function isValidationTraceEnabled(): boolean {
  return current().enabled;
}

function emit(rt: TraceRuntime, line: TraceLine): void {
  const json = JSON.stringify(line);
  rt.sink.write(json);
  rt.log(json);
}

function warnOnce(rt: TraceRuntime, key: string, message: string): void {
  if (rt.warned.has(key)) return;
  rt.warned.add(key);
  new Logger('validation').warn(message);
}

function summaryLine(rt: TraceRuntime, key: string, state: SamplingWindow): TraceLine {
  const [check, outcome] = key.split('|');
  return {
    v: 1, ts: new Date(rt.now()).toISOString(), app: appName(rt.env), env: rt.env.APP_ENV?.trim().toLowerCase() ?? '',
    check, outcome: outcome as ValidationOutcome, kind: 'summary', suppressed: state.suppressed, windowMs: WINDOW_MS,
  };
}

function flushWindow(rt: TraceRuntime, key: string): void {
  const state = rt.windows.get(key);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.suppressed > 0) emit(rt, summaryLine(rt, key, state));
  state.suppressed = 0;
}

/** Writes the summary lines of the lines suppressed by sampling (also done at each window end and at shutdown). */
export function flushValidationTrace(): void {
  if (!runtime) return;
  const rt = runtime;
  try {
    for (const key of rt.windows.keys()) flushWindow(rt, key);
  } catch {
    /* never throws */
  }
}

/** Sampling: at most `perMinute` detailed lines per (check, outcome) and per minute, the rest counted in one summary line. */
function admit(rt: TraceRuntime, check: string, outcome: ValidationOutcome): boolean {
  let key = `${check}|${outcome}`;
  if (!rt.windows.has(key) && rt.windows.size >= MAX_SAMPLING_KEYS) key = `validation.trace.overflow|${outcome}`;
  const now = rt.now();
  let state = rt.windows.get(key);
  if (!state || now - state.start >= WINDOW_MS) {
    if (state) flushWindow(rt, key);
    state = { start: now, written: 0, suppressed: 0, timer: null };
    rt.windows.set(key, state);
  }
  if (state.written < rt.perMinute && !key.startsWith('validation.trace.overflow')) {
    state.written += 1;
    return true;
  }
  state.suppressed += 1;
  if (!state.timer) {
    state.timer = setTimeout(() => {
      try {
        flushWindow(rt, key);
      } catch {
        /* a timer must never throw */
      }
    }, Math.max(0, state.start + WINDOW_MS - now));
    state.timer.unref?.();
  }
  return false;
}

function appName(env: Env): string {
  const name = env.PROJECT_NAME?.trim() ?? '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : 'unknown';
}

function resolveFields(fields: LazyTraceFields | undefined): unknown {
  if (typeof fields !== 'function') return fields;
  try {
    return fields();
  } catch {
    return { fieldsError: true };
  }
}

/**
 * Records one trace (the common path of `vtrace` and of the front relay). Assumes the caller checked that traces are
 * enabled. Never throws: a failure is logged once.
 */
export function recordValidationTrace(check: string, outcome: ValidationOutcome, fields?: LazyTraceFields, source: ValidationSource = 'back'): void {
  const rt = current();
  if (!rt.enabled) return;
  try {
    if (!isValidCheckName(check) || !VALIDATION_OUTCOMES.includes(outcome)) throw new TraceRejectedError('invalid check name or outcome');
    if (!admit(rt, check, outcome)) return;
    const line = buildTraceLine({ check, outcome, source, fields: resolveFields(fields), env: rt.env, app: appName(rt.env), now: rt.now() });
    emit(rt, line);
  } catch (error) {
    const reason = error instanceof TraceRejectedError ? error.message : 'unexpected error';
    warnOnce(rt, `record:${reason}`, `validation trace dropped (${reason})`);
  }
}

/**
 * Validation trace at a decision or control point (dev/preprod only). In production, or without `APP_ENV`, it costs a
 * boolean test: nothing is evaluated (pass `fields` as a function when computing them costs anything) nor written.
 * Never pass a secret, a token or raw personal data: fields are sanitized anyway (see `traceSanitizer.ts`).
 *
 * @example vtrace('user.login.otp-required', 'ok', () => ({ method: 'email', attempts }));
 */
export function vtrace(check: string, outcome: ValidationOutcome, fields?: LazyTraceFields): void {
  if (!current().enabled) return;
  recordValidationTrace(check, outcome, fields, 'back');
}
