/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import { currentCheckIndex, setCheckRoots } from './checkIndex';
import { TraceClass, TraceFileSink, resolveValidationLogDir } from './traceFileSink';
import { TraceLine, TraceRejectedError, buildTraceLine, isValidCheckName } from './traceLine';
import { TraceFieldRules, TraceFields, deriveFingerprintKey, fingerprint, setFingerprintKey } from './traceSanitizer';

/** Outcome of a control: `ok` = behaved as specified, `violation` = non-conformity observed, `info` = context only. */
export type ValidationOutcome = 'ok' | 'violation' | 'info';
export const VALIDATION_OUTCOMES: readonly ValidationOutcome[] = ['ok', 'violation', 'info'];
/** Where a trace was emitted. */
export type ValidationSource = 'back' | 'front';
/** Fields of a trace, or a function computing them: called only when the trace is really written (never in production). */
export type LazyTraceFields = TraceFields | (() => TraceFields);

/** `APP_ENV` values with which traces can be active (`dev`: by default; `preprod`: only with `VALIDATION_TRACE=on`). */
export const VALIDATION_TRACE_ENVS: readonly string[] = ['dev', 'preprod'];

type Env = Record<string, string | undefined>;

export interface ValidationTraceOptions {
  /** Environment read once (default `process.env`). */
  env?: Env;
  /** Clock (tests). */
  now?: () => number;
  /** Line writer (tests); default: the daily JSONL file. */
  sink?: { write(line: string, traceClass?: TraceClass): boolean };
  /** Nest logger output (tests); default `new Logger('validation').log`. */
  log?: (line: string) => void;
  /** Module folders holding `<module>/validation/checks.json` (tests); default `src/modules_shared` and `src/modules`. */
  checkRoots?: string[];
}

/**
 * Whether traces are active for `env` (fail-closed): `APP_ENV=dev` unless `VALIDATION_TRACE=off`; `APP_ENV=preprod`
 * only with `VALIDATION_TRACE=on` (explicit opt-in: a production `.env` copied from the example says `dev`, and a
 * deploy of `back/.env` forces `off`); anything else, no `APP_ENV`, or a `VALIDATION_TRACE` other than on/off: off.
 * Under a test runner (`NODE_ENV=test`) off unless `VALIDATION_TRACE=on`.
 */
export function isValidationTraceEnabledFor(env: Env): boolean {
  const appEnv = env.APP_ENV?.trim().toLowerCase() ?? '';
  const flag = env.VALIDATION_TRACE?.trim().toLowerCase() ?? '';
  if (flag !== '' && flag !== 'on') return false;
  if (env.NODE_ENV === 'test' && flag !== 'on') return false;
  return appEnv === 'dev' || (appEnv === 'preprod' && flag === 'on');
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

/** Distinct sampling keys followed; beyond, lines are only counted under `validation.trace.overflow`. */
const MAX_SAMPLING_KEYS = 1000;
/** Distinct front clients followed (per check and outcome); beyond, expired then least recently used entries are evicted. */
const MAX_CLIENT_KEYS = 1000;
const WINDOW_MS = 60_000;
/** Detailed front lines per client, check and outcome and per minute (the global per-minute budget still applies). */
const FRONT_PER_CLIENT_PER_MINUTE = 5;

interface TraceRuntime {
  enabled: boolean;
  env: Env;
  now: () => number;
  sink: { write(line: string, traceClass?: TraceClass): boolean };
  log: (line: string) => void;
  perMinute: number;
  windows: Map<string, SamplingWindow>;
  clients: Map<string, { start: number; written: number }>;
  warned: Set<string>;
}

let runtime: TraceRuntime | null = null;

function appName(env: Env): string {
  const name = env.PROJECT_NAME?.trim() ?? '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : 'unknown';
}

function cappedLine(env: Env, now: () => number) {
  return (traceClass: TraceClass, maxBytes: number): string =>
    JSON.stringify(buildTraceLine({
      check: 'validation.trace.capped', outcome: 'info', source: 'back', fields: { traceClass, maxBytes }, rules: { traceClass: ['front', 'back', 'violation'], maxBytes: 'number' },
      env, app: appName(env), now: now(),
    }));
}

function defaultSink(env: Env, now: () => number, onFailure: (reason: string) => void) {
  return new TraceFileSink({
    dir: resolveValidationLogDir(env),
    maxBytes: intSetting(env, 'VALIDATION_TRACE_MAX_MB', 20, 1, 500) * 1024 * 1024,
    retentionDays: intSetting(env, 'VALIDATION_TRACE_RETENTION_DAYS', 7, 1, 90),
    now,
    onFailure,
    cappedLine: cappedLine(env, now),
  });
}

function createRuntime(options: ValidationTraceOptions): TraceRuntime {
  const env = options.env ?? process.env;
  const enabled = isValidationTraceEnabledFor(env);
  const logger = new Logger('validation');
  const warned = new Set<string>();
  const now = options.now ?? Date.now;
  const onFailure = (reason: string) => {
    if (!warned.has(`sink:${reason}`)) logger.warn(`validation trace file disabled (${reason})`);
    warned.add(`sink:${reason}`);
  };
  if (enabled) setFingerprintKey(deriveFingerprintKey(env));
  setCheckRoots(options.checkRoots ?? null);
  const sink = options.sink ?? (enabled ? defaultSink(env, now, onFailure) : { write: () => false });
  const log = options.log ?? ((line: string) => logger.log(line));
  const perMinute = intSetting(env, 'VALIDATION_TRACE_PER_MINUTE', 20, 1, 1000);
  return { enabled, env, now, sink, log, perMinute, windows: new Map(), clients: new Map(), warned };
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

function classOf(line: TraceLine): TraceClass {
  if (line.source === 'front') return 'front';
  return line.outcome === 'violation' ? 'violation' : 'back';
}

function emit(rt: TraceRuntime, line: TraceLine): void {
  const json = JSON.stringify(line);
  rt.sink.write(json, classOf(line));
  rt.log(json);
}

function warnOnce(rt: TraceRuntime, key: string, message: string): void {
  if (rt.warned.has(key)) return;
  rt.warned.add(key);
  new Logger('validation').warn(message);
}

function summaryLine(rt: TraceRuntime, key: string, state: SamplingWindow): TraceLine {
  const [source, check, outcome] = key.split('|');
  return {
    v: 1, ts: new Date(rt.now()).toISOString(), app: appName(rt.env), env: rt.env.APP_ENV?.trim().toLowerCase() ?? '',
    check, outcome: outcome as ValidationOutcome, source: source as ValidationSource, kind: 'summary', suppressed: state.suppressed, windowMs: WINDOW_MS,
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

function suppress(rt: TraceRuntime, key: string, state: SamplingWindow, now: number): false {
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

/** Bounds the client table: expired windows go first, then the least recently used entries (Map order = LRU order). */
function evictClients(rt: TraceRuntime, now: number): void {
  for (const [key, state] of rt.clients) {
    if (rt.clients.size < MAX_CLIENT_KEYS) return;
    if (now - state.start >= WINDOW_MS) rt.clients.delete(key);
  }
  for (const key of rt.clients.keys()) {
    if (rt.clients.size < MAX_CLIENT_KEYS) return;
    rt.clients.delete(key);
  }
}

/** Per-client budget of the front (in memory only: the client key is a fingerprint, never written). */
function clientAllows(rt: TraceRuntime, clientKey: string, now: number): boolean {
  const state = rt.clients.get(clientKey);
  rt.clients.delete(clientKey); // re-inserted below: most recently used last
  if (!state || now - state.start >= WINDOW_MS) {
    evictClients(rt, now);
    rt.clients.set(clientKey, { start: now, written: 1 });
    return true;
  }
  state.written += 1;
  rt.clients.set(clientKey, state);
  return state.written <= FRONT_PER_CLIENT_PER_MINUTE;
}

/** Size of the in-memory client table (tests). */
export function validationTraceClientCount(): number {
  return runtime?.clients.size ?? 0;
}

/** Sampling per (source, check, outcome) — and per client for the front — then one summary line per window. */
function admit(rt: TraceRuntime, source: ValidationSource, check: string, outcome: ValidationOutcome, client?: string): boolean {
  let key = `${source}|${check}|${outcome}`;
  if (!rt.windows.has(key) && rt.windows.size >= MAX_SAMPLING_KEYS) key = `${source}|validation.trace.overflow|${outcome}`;
  const now = rt.now();
  let state = rt.windows.get(key);
  if (!state || now - state.start >= WINDOW_MS) {
    if (state) flushWindow(rt, key);
    state = { start: now, written: 0, suppressed: 0, timer: null };
    rt.windows.set(key, state);
  }
  if (key.includes('validation.trace.overflow') || state.written >= rt.perMinute) return suppress(rt, key, state, now);
  if (source === 'front' && !clientAllows(rt, `${client ?? 'anonymous'}|${check}|${outcome}`, now)) return suppress(rt, key, state, now);
  state.written += 1;
  return true;
}

function resolveFields(fields: LazyTraceFields | undefined): unknown {
  if (typeof fields !== 'function') return fields;
  try {
    return fields();
  } catch {
    return { fieldsError: true };
  }
}

/** Field rules of a trace: those its checks declare for the source; `null` (every field dropped) when undeclared. */
function rulesFor(source: ValidationSource, check: string): TraceFieldRules | null {
  const index = currentCheckIndex();
  return (source === 'front' ? index.front.get(check)?.fields : index.back.get(check)) ?? null;
}

export interface RecordContext {
  source?: ValidationSource;
  /** Front only: who sent it (user id or IP), used for the per-client budget; fingerprinted, never written. */
  client?: string;
}

/**
 * Records one trace (the common path of `vtrace` and of the front relay). Assumes the caller checked that traces are
 * enabled. Never throws: a failure is logged once.
 */
export function recordValidationTrace(check: string, outcome: ValidationOutcome, fields?: LazyTraceFields, context: RecordContext = {}): void {
  const rt = current();
  if (!rt.enabled) return;
  const source = context.source ?? 'back';
  try {
    if (!isValidCheckName(check) || !VALIDATION_OUTCOMES.includes(outcome)) throw new TraceRejectedError('invalid check name or outcome');
    if (!admit(rt, source, check, outcome, context.client ? fingerprint(context.client) : undefined)) return;
    const rules = rulesFor(source, check);
    if (rules === null) warnOnce(rt, `undeclared:${check}`, `validation trace "${check}" is declared by no checks.json: its fields are dropped`);
    emit(rt, buildTraceLine({ check, outcome, source, fields: resolveFields(fields), rules, env: rt.env, app: appName(rt.env), now: rt.now() }));
  } catch (error) {
    const reason = error instanceof TraceRejectedError ? error.message : 'unexpected error';
    warnOnce(rt, `record:${reason}`, `validation trace dropped (${reason})`);
  }
}

/**
 * Validation trace at a decision or control point (dev/preprod only). In production, or without `APP_ENV`, it costs a
 * boolean test: nothing is evaluated (pass `fields` as a function when computing them costs anything) nor written.
 * Only the fields the check declares in its `checks.json` are kept, then sanitized (a safety net, not a licence: never
 * pass a secret, a token or raw personal data).
 *
 * @example vtrace('user.login.otp-required', 'ok', () => ({ method: 'email', attempts }));
 */
export function vtrace(check: string, outcome: ValidationOutcome, fields?: LazyTraceFields): void {
  if (!current().enabled) return;
  recordValidationTrace(check, outcome, fields);
}
