/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createHash } from 'crypto';
import { maskEmailAddresses } from '../services/EmailService';
import { SECRET_SEGMENT_PREFIXES, isSecretSegment } from '../utils/redactPath';

/** A value a validation trace may carry once sanitized: scalars, or a short list of scalars. */
export type TraceScalar = string | number | boolean | null;
export type TraceValue = TraceScalar | TraceScalar[];
/** Raw fields given to `vtrace`: only simple types are kept, everything else is replaced by a placeholder. */
export type TraceFields = Record<string, unknown>;

/** Size limits of a trace (per field, per line). */
export const TRACE_LIMITS = Object.freeze({
  maxFields: 24,
  maxKeyLength: 48,
  maxStringLength: 200,
  maxArrayItems: 10,
  maxLineBytes: 4096,
});

/** Replaces the value of a field whose NAME is sensitive (`[redacted]`, or `[redacted:<length>]` for a string). */
export const REDACTED = '[redacted]';

/**
 * Field-name fragments whose value is never written (normalized: lower case, letters and digits only). Matching is by
 * substring, on purpose: `privateKey`, `x-api-key`, `otpCode`, `sessionId`, `walletSeed` are all caught. Booleans and
 * null still pass (`hasToken: true` tells nothing). Over-redaction is the accepted price: rename a harmless field
 * (`tokenSymbol` → `asset`) rather than shrinking this list.
 */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'secret', 'token', 'password', 'passwd', 'pwd', 'passphrase', 'pphrase', 'key', 'auth', 'bearer', 'cookie', 'session',
  'credential', 'proof', 'code', 'otp', 'signature', 'seed', 'mnemonic', 'salt', 'jwt', 'cipher', 'recovery',
];

/** Exact (normalized) names exempted from the `code` fragment: they never carry a secret. */
const SAFE_CODE_KEYS = new Set(['statuscode', 'errorcode', 'httpcode', 'reasoncode', 'countrycode', 'currencycode', 'languagecode', 'localecode']);

/** Field-name fragments of personal data: the value is replaced by its fingerprint (correlation stays possible). */
export const PERSONAL_KEY_FRAGMENTS: readonly string[] = [
  'email', 'phone', 'iban', 'ssn', 'birth', 'firstname', 'lastname', 'fullname', 'username', 'street', 'postal', 'zipcode', 'ipaddress', 'clientip',
];

/** Token prefixes of the apps and of common providers (in addition to `redactPath`'s list). */
const TOKEN_PREFIXES: readonly string[] = [...SECRET_SEGMENT_PREFIXES, 'tk_', 'ctd_', 'mst_', 'ac_live_', 'ac_test_', 'sup_', 'sk-', 'AKIA'];

const STRUCTURAL_SECRET_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/, // JWT
  /\bbearer\s+\S{8,}/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
  /-----BEGIN [A-Z ]*-----/, // PEM block
  /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, // credentials in a URL
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|pphrase|passphrase)["']?\s*[:=]\s*["']?[^\s"']{3,}/i,
];

/** Candidate runs of a text, then the sub-runs examined in each (a superset of what `validation-report.mjs` flags as a leak). */
const CANDIDATE_RUN = /[A-Za-z0-9+/_.~=-]{8,}/g;
const BASE64_SUBRUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const SEGMENT_SUBRUN = /[A-Za-z0-9_\-.~+=]{20,}/g;
const HEX_SECRET = /^(?:0x)?[0-9a-fA-F]{32,}$/;
const BASE64_RUN = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** `sha256:<first 8 hex>` of a value: stable, so two traces of the same value can be correlated without showing it. */
export function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** Fingerprint + length, the only thing a trace ever says about a secret-looking string. */
function fingerprintWithLength(value: string): string {
  return `${fingerprint(value)};len=${value.length}`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a field NAME is sensitive (its value is never written). */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_CODE_KEYS.has(normalized)) return false;
  return normalized === 'pin' || normalized.endsWith('pin') || SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Whether a field NAME holds personal data (its value is replaced by a fingerprint). */
export function isPersonalKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized === 'ip' || PERSONAL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isTokenLike(part: string): boolean {
  if (part.length < 8) return false;
  if (TOKEN_PREFIXES.some((prefix) => part.startsWith(prefix) && part.length >= prefix.length + 8)) return true;
  if (HEX_SECRET.test(part)) return true;
  if (isSecretSegment(part)) return true;
  return BASE64_RUN.test(part) && /[0-9]/.test(part) && /[A-Z]/.test(part) && /[a-z]/.test(part);
}

function runLooksSecret(run: string): boolean {
  const candidates = [run, ...run.split(/[/.=]/), ...(run.match(BASE64_SUBRUN) ?? []), ...(run.match(SEGMENT_SUBRUN) ?? [])];
  return candidates.some(isTokenLike);
}

/** Whether a free text contains something that looks like a secret (token, key, credential, PEM block...). */
export function looksSecret(text: string): boolean {
  if (STRUCTURAL_SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return (text.match(CANDIDATE_RUN) ?? []).some(runLooksSecret);
}

/**
 * A string fit for a trace: secret-looking ⇒ replaced as a whole by `sha256:<8 hex>;len=<n>`; otherwise e-mail
 * addresses masked (`j***@example.fr`), control characters dropped, cut at {@link TRACE_LIMITS.maxStringLength}.
 */
export function sanitizeTraceString(value: string): string {
  const flat = value.replace(CONTROL_CHARS, ' ');
  if (looksSecret(flat)) return fingerprintWithLength(value);
  const masked = maskEmailAddresses(flat);
  const max = TRACE_LIMITS.maxStringLength;
  return masked.length > max ? `${masked.slice(0, max)}…[+${masked.length - max}]` : masked;
}

function sanitizeScalar(value: unknown): TraceScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return sanitizeTraceString(value.toString());
  if (typeof value === 'string') return sanitizeTraceString(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return `[error ${sanitizeTraceString(value.name).slice(0, 40)}]`;
  return Array.isArray(value) ? '[array]' : `[${typeof value}]`;
}

/** Value of a sensitive field: nothing of it but its kind and length. */
function redactValue(value: unknown): TraceScalar {
  if (value === null || value === undefined || typeof value === 'boolean') return (value ?? null) as TraceScalar;
  if (typeof value === 'string') return `${REDACTED.slice(0, -1)}:${value.length}]`;
  return REDACTED;
}

/** Value of a personal-data field: its fingerprint only. */
function pseudonymize(value: unknown): TraceScalar {
  if (value === null || value === undefined || typeof value === 'boolean') return (value ?? null) as TraceScalar;
  return typeof value === 'string' || typeof value === 'number' ? fingerprint(String(value)) : REDACTED;
}

function sanitizeValue(key: string, value: unknown): TraceValue {
  if (isSensitiveKey(key)) return Array.isArray(value) ? REDACTED : redactValue(value);
  if (isPersonalKey(key)) return Array.isArray(value) ? REDACTED : pseudonymize(value);
  if (!Array.isArray(value)) return sanitizeScalar(value);
  const items = value.slice(0, TRACE_LIMITS.maxArrayItems).map((item) => sanitizeScalar(item));
  return value.length > TRACE_LIMITS.maxArrayItems ? [...items, `[+${value.length - TRACE_LIMITS.maxArrayItems}]`] : items;
}

/**
 * Sanitized copy of trace fields: at most {@link TRACE_LIMITS.maxFields} keys with a plain name, simple values only
 * (nested objects become `[object]`, never serialized), sensitive names redacted, personal data fingerprinted, secret-
 * looking strings fingerprinted, e-mails masked. Pure; never throws on odd input (getters that throw are skipped).
 */
export function sanitizeTraceFields(fields: unknown): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  let kept = 0;
  let dropped = 0;
  for (const key of Object.keys(fields)) {
    if (kept >= TRACE_LIMITS.maxFields || key.length > TRACE_LIMITS.maxKeyLength || !KEY_NAME.test(key)) {
      dropped += 1;
      continue;
    }
    try {
      out[key] = sanitizeValue(key, (fields as Record<string, unknown>)[key]);
      kept += 1;
    } catch {
      dropped += 1;
    }
  }
  if (dropped) out._droppedFields = dropped;
  return out;
}
