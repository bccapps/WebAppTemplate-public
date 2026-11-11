/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Evaluation of the registry checks against the trace lines (validation by observation, `nest/common/README.md`) and
 * the difference between two runs (`--follow-up`). Pure functions, zero dependencies, ESM.
 */

import { scrubForDisplay } from './validation-logs.mjs';

export const STATUS = Object.freeze({ VIOLATION: 'VIOLATION', OK: 'OBSERVED_OK', NOT_YET: 'NOT_YET_OBSERVED' });
const BLOCKING = new Set(['critical', 'high']);
const MAX_SAMPLES = 3;
const MAX_SAMPLE_LENGTH = 400;

/** `<trace>` or `<trace>:<outcome>` → matcher of a trace line. */
function forbiddenMatcher(spec) {
  const [check, outcome] = spec.split(':');
  return (entry) => entry.check === check && (!outcome || entry.outcome === outcome);
}

/** Occurrences a line stands for: 1, or the suppressed count of a sampling summary line. */
function weight(entry) {
  return entry.kind === 'summary' ? Number(entry.suppressed) || 0 : 1;
}

function sample(line) {
  const text = scrubForDisplay(line.raw);
  return text.length > MAX_SAMPLE_LENGTH ? `${text.slice(0, MAX_SAMPLE_LENGTH)}…` : text;
}

function newResult(check) {
  return {
    id: check.id, module: check.module, title: check.title, severity: check.severity, status: STATUS.NOT_YET,
    counts: { ok: 0, info: 0, violation: 0, forbidden: 0 }, first: null, last: null, samples: [], file: check.file,
  };
}

function record(result, line, kind) {
  const ts = line.entry.ts ?? null;
  result.counts[kind] += weight(line.entry);
  if (ts && (!result.first || ts < result.first)) result.first = ts;
  if (ts && (!result.last || ts > result.last)) result.last = ts;
  const wantsSample = kind === 'violation' || kind === 'forbidden' || result.counts.violation + result.counts.forbidden === 0;
  if (wantsSample && line.entry.kind !== 'summary') {
    if (kind === 'violation' || kind === 'forbidden') result.samples = result.samples.filter((s) => s.bad);
    if (result.samples.length < MAX_SAMPLES) result.samples.push({ bad: kind === 'violation' || kind === 'forbidden', text: sample(line) });
  }
}

function statusOf(result, expected) {
  if (result.counts.violation + result.counts.forbidden > 0) return STATUS.VIOLATION;
  return result.counts[expected] > 0 ? STATUS.OK : STATUS.NOT_YET;
}

/** One result per check: status, counts, first/last occurrence, up to 3 scrubbed sample lines. */
export function evaluateChecks(checks, lines) {
  return checks.map((check) => {
    const traces = new Set(check.expect.traces);
    const forbidden = (check.mustNotHappen ?? []).map(forbiddenMatcher);
    const result = newResult(check);
    for (const line of lines) {
      const { entry } = line;
      if (forbidden.some((matches) => matches(entry))) record(result, line, 'forbidden');
      else if (traces.has(entry.check) && ['ok', 'info', 'violation'].includes(entry.outcome)) record(result, line, entry.outcome);
    }
    result.status = statusOf(result, check.expect.outcome);
    result.samples = result.samples.map((s) => s.text);
    return result;
  });
}

/** Trace names seen in the logs that no check references (instrumentation without a registry entry). */
export function unknownTraces(checks, lines) {
  const known = new Set(checks.flatMap((c) => [...c.expect.traces, ...(c.mustNotHappen ?? []).map((s) => s.split(':')[0])]));
  const counts = new Map();
  for (const { entry } of lines) {
    if (known.has(entry.check) || entry.check.startsWith('validation.trace.')) continue;
    counts.set(entry.check, (counts.get(entry.check) ?? 0) + weight(entry));
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([check, count]) => ({ check, count }));
}

/** Whether a result blocks (exit code 1): a VIOLATION of a critical or high check. */
export function isBlocking(result) {
  return result.status === STATUS.VIOLATION && BLOCKING.has(result.severity);
}

/** Compact state saved between two `--follow-up` runs. */
export function toState(results, leaks) {
  return {
    checks: Object.fromEntries(results.map((r) => [r.id, { status: r.status, violation: r.counts.violation + r.counts.forbidden, ok: r.counts.ok + r.counts.info }])),
    leaks: [...new Set(leaks.map((l) => `${l.type}|${l.fingerprint}`))],
  };
}

/** Changes since the previous state: new/removed checks, status changes, more violations, new leak fingerprints. */
export function diffStates(previous, results, leaks) {
  const changes = [];
  const before = previous?.checks ?? {};
  for (const result of results) {
    const old = before[result.id];
    const violations = result.counts.violation + result.counts.forbidden;
    if (!old) changes.push({ kind: 'new-check', id: result.id, status: result.status });
    else if (old.status !== result.status) changes.push({ kind: 'status', id: result.id, from: old.status, to: result.status });
    else if (violations > old.violation) changes.push({ kind: 'more-violations', id: result.id, added: violations - old.violation });
  }
  const ids = new Set(results.map((r) => r.id));
  for (const id of Object.keys(before)) if (!ids.has(id)) changes.push({ kind: 'removed-check', id });
  const knownLeaks = new Set(previous?.leaks ?? []);
  const fresh = leaks.filter((l) => !knownLeaks.has(`${l.type}|${l.fingerprint}`));
  if (fresh.length) changes.push({ kind: 'new-leaks', leaks: fresh });
  return changes;
}
