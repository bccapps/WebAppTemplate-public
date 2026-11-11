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
 * the difference between two runs (`--follow-up`). Evaluation is PER SOURCE: a front trace never counts for a check
 * that is not declared `"front"`, and a critical/high check is only OBSERVED_OK on back traces (the front, reachable
 * without a session for pre-login checks, cannot fake the evidence). Pure functions, zero dependencies, ESM.
 */

import { scrubForDisplay } from './validation-logs.mjs';

/**
 * `VIOLATION_TO_CONFIRM`: violations reported by the FRONT only, on a pre-login check (anyone can send those, without a
 * session): shown, never blocking, to be reproduced with a back trace.
 */
export const STATUS = Object.freeze({ VIOLATION: 'VIOLATION', TO_CONFIRM: 'VIOLATION_TO_CONFIRM', OK: 'OBSERVED_OK', NOT_YET: 'NOT_YET_OBSERVED' });
const BLOCKING = new Set(['critical', 'high']);
const MAX_SAMPLES = 3;
const MAX_SAMPLE_LENGTH = 400;
const KINDS = ['ok', 'info', 'violation', 'forbidden'];

/** `<trace>` or `<trace>:<outcome>` → matcher of a trace line. */
function forbiddenMatcher(spec) {
  const [check, outcome] = spec.split(':');
  return (entry) => entry.check === check && (!outcome || entry.outcome === outcome);
}

/** Occurrences a line stands for: 1, or the suppressed count of a sampling summary line. */
function weight(entry) {
  return entry.kind === 'summary' ? Number(entry.suppressed) || 0 : 1;
}

const sourceOf = (entry) => (entry.source === 'front' ? 'front' : 'back');

/**
 * What a sample line shows. By default only the shape (time, check, outcome, source, field NAMES): the report is read at
 * every session start and pasted into conversations. Values only with `showValues` (scrubbed again, cut at 400).
 */
export function sampleOf(line, showValues = false) {
  if (showValues) {
    const text = scrubForDisplay(line.raw.slice(0, 4096));
    return text.length > MAX_SAMPLE_LENGTH ? `${text.slice(0, MAX_SAMPLE_LENGTH)}…` : text;
  }
  const { ts, check, outcome, fields } = line.entry;
  const names = fields && typeof fields === 'object' ? Object.keys(fields).join(', ') : '';
  return `${ts ?? '?'} ${check} ${outcome} (${sourceOf(line.entry)})${names ? ` fields: ${names}` : ''}`;
}

function newResult(check) {
  const zero = () => ({ back: 0, front: 0 });
  return {
    id: check.id, module: check.module, title: check.title, severity: check.severity, sources: check.sources, status: STATUS.NOT_YET,
    counts: Object.fromEntries(KINDS.map((k) => [k, zero()])), ignoredFront: 0, first: null, last: null, samples: [], note: null, file: check.file,
  };
}

function record(result, line, kind, showValues) {
  const ts = line.entry.ts ?? null;
  result.counts[kind][sourceOf(line.entry)] += weight(line.entry);
  if (ts && (!result.first || ts < result.first)) result.first = ts;
  if (ts && (!result.last || ts > result.last)) result.last = ts;
  const bad = kind === 'violation' || kind === 'forbidden';
  if (line.entry.kind === 'summary' || (!bad && result.samples.some((s) => s.bad))) return;
  if (bad) result.samples = result.samples.filter((s) => s.bad);
  if (result.samples.length < MAX_SAMPLES) result.samples.push({ bad, text: sampleOf(line, showValues) });
}

const total = (pair) => pair.back + pair.front;

function statusOf(result, check) {
  const { counts } = result;
  const backViolations = counts.violation.back + counts.forbidden.back;
  const frontViolations = counts.violation.front + counts.forbidden.front;
  if (backViolations > 0 || (frontViolations > 0 && check.preLogin !== true)) return STATUS.VIOLATION;
  if (frontViolations > 0) {
    result.note = 'violation reported by the front only, on a pre-login check (unauthenticated): to confirm with a back trace';
    return STATUS.TO_CONFIRM;
  }
  const expected = counts[check.expect.outcome];
  if (expected.back > 0) return STATUS.OK;
  if (expected.front > 0 && !BLOCKING.has(check.severity)) return STATUS.OK;
  if (expected.front > 0) result.note = 'front traces only: a critical/high check is proven by back traces';
  return STATUS.NOT_YET;
}

/** One result per check: status, counts per source, first/last occurrence, up to 3 sample lines. */
export function evaluateChecks(checks, lines, { showValues = false } = {}) {
  return checks.map((check) => {
    const traces = new Set(check.expect.traces);
    const forbidden = (check.mustNotHappen ?? []).map(forbiddenMatcher);
    const acceptsFront = check.sources.includes('front');
    const result = newResult(check);
    for (const line of lines) {
      const { entry } = line;
      const matches = forbidden.some((m) => m(entry)) ? 'forbidden' : traces.has(entry.check) && KINDS.includes(entry.outcome) ? entry.outcome : null;
      if (!matches) continue;
      if (sourceOf(entry) === 'front' && !acceptsFront) result.ignoredFront += weight(entry);
      else record(result, line, matches, showValues);
    }
    result.status = statusOf(result, check);
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

const violationsOf = (r) => total(r.counts.violation) + total(r.counts.forbidden);

/** Compact state saved between two `--follow-up` runs. */
export function toState(results, leaks) {
  return {
    checks: Object.fromEntries(results.map((r) => [r.id, { status: r.status, violation: violationsOf(r), ok: total(r.counts.ok) + total(r.counts.info) }])),
    leaks: [...new Set(leaks.map((l) => l.identity))],
  };
}

/** Changes since the previous state: new/removed checks, status changes, more violations, new leaks. */
export function diffStates(previous, results, leaks) {
  const changes = [];
  const before = previous?.checks ?? {};
  for (const result of results) {
    const old = before[result.id];
    const violations = violationsOf(result);
    if (!old) changes.push({ kind: 'new-check', id: result.id, status: result.status });
    else if (old.status !== result.status) changes.push({ kind: 'status', id: result.id, from: old.status, to: result.status });
    else if (violations > old.violation) changes.push({ kind: 'more-violations', id: result.id, added: violations - old.violation });
  }
  const ids = new Set(results.map((r) => r.id));
  for (const id of Object.keys(before)) if (!ids.has(id)) changes.push({ kind: 'removed-check', id });
  const knownLeaks = new Set(previous?.leaks ?? []);
  const fresh = leaks.filter((l) => !knownLeaks.has(l.identity));
  if (fresh.length) changes.push({ kind: 'new-leaks', leaks: fresh });
  return changes;
}
