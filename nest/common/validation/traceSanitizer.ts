/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createHmac, hkdfSync, randomBytes } from 'crypto';
import { maskEmailAddresses } from '../services/EmailService';
import { SECRET_SEGMENT_PREFIXES } from '../utils/redactPath';

/** A value a validation trace may carry once sanitized: scalars, or a short list of scalars (`"*"` fields only). */
export type TraceScalar = string | number | boolean | null;
export type TraceValue = TraceScalar | TraceScalar[];
/** Raw fields given to `vtrace`. */
export type TraceFields = Record<string, unknown>;

/**
 * Declared type of a field in `checks.json` (`"fields"`): a list of strings is an enumeration (only those exact values
 * are kept, verbatim); `id` is always replaced by its keyed fingerprint (correlation without the value).
 */
export type TraceFieldType = 'string' | 'number' | 'boolean' | 'id' | readonly string[];
/** Fields a check allows: a map name → type, or `"*"` (any simple field, back-only checks, justified in the registry). */
export type TraceFieldRules = '*' | Readonly<Record<string, TraceFieldType>>;

/** Size limits of a trace (per field, per line). */
export const TRACE_LIMITS = Object.freeze({
  maxFields: 24,
  maxKeyLength: 48,
  maxStringLength: 200,
  /** Longer strings are never examined: replaced by their fingerprint at once (no regular expression runs on them). */
  maxExaminedLength: 1024,
  maxArrayItems: 10,
  maxLineBytes: 4096,
});

/** Replaces the value of a field whose NAME is sensitive (`[redacted]`, or `[redacted:<length>]` for a string). */
export const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------------------------------------------------
// Keyed fingerprints. A plain hash of a short value (a birth date, a phone number) is reversed by enumeration: the
// fingerprint is an HMAC under a key derived from CRYPT_DB_MASTER_KEY (stable across restarts and processes of one
// environment, never written anywhere), or a random per-process key when it is not set.
// ---------------------------------------------------------------------------------------------------------------------

const FINGERPRINT_HEX = 16;
let fingerprintKey: Buffer = randomBytes(32);

/** Fingerprint key of an environment (HKDF of `CRYPT_DB_MASTER_KEY`), or a random key when it is not set. */
export function deriveFingerprintKey(env: Record<string, string | undefined>): Buffer {
  const master = env.CRYPT_DB_MASTER_KEY?.trim();
  if (!master) return randomBytes(32);
  const info = `${env.PROJECT_NAME?.trim() ?? ''}|${env.APP_ENV?.trim().toLowerCase() ?? ''}`;
  return Buffer.from(hkdfSync('sha256', master, 'vx-validation-trace-fingerprint-v1', info, 32));
}

export function setFingerprintKey(key: Buffer): void {
  fingerprintKey = Buffer.from(key);
}

/** `hmac:<16 hex>` of a value: stable within an environment, irreversible without the key. */
export function fingerprint(value: string): string {
  return `hmac:${createHmac('sha256', fingerprintKey).update(value).digest('hex').slice(0, FINGERPRINT_HEX)}`;
}

function fingerprintWithLength(value: string): string {
  return `${fingerprint(value)};len=${value.length}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Field names. Long fragments match anywhere in the normalized name; short ones only as a whole word of the name
// (`newPass` → new, pass; `userIp` → user, ip), so `author` or `monkey` stay readable.
// ---------------------------------------------------------------------------------------------------------------------

const SECRET_FRAGMENTS = [
  'secret', 'token', 'password', 'passwd', 'passphrase', 'pphrase', 'credential', 'signature', 'mnemonic', 'cookie', 'session',
  'bearer', 'authoriz', 'oauth', 'apikey', 'accesskey', 'privatekey', 'cipher', 'recovery', 'seed', 'salt', 'jwt', 'otp', 'hmac',
  'csrf', 'xsrf', 'nonce', 'verification', 'cardnumber', 'creditcard', 'cvv', 'proof',
];
const SECRET_WORDS = new Set([
  'pass', 'pwd', 'pw', 'mdp', 'creds', 'cred', 'sid', 'sig', 'key', 'keys', 'auth', 'code', 'pin', 'cvc', 'cvn', 'card', 'cc', 'pan',
  'phrase', 'iv', 'entered', 'verify', 'verifier', 'challenge', 'answer', 'tan',
]);
/** Exact names exempted from the `code` word: they never carry a secret. */
const SAFE_NAMES = new Set(['statuscode', 'errorcode', 'httpcode', 'reasoncode', 'countrycode', 'currencycode', 'languagecode', 'localecode']);
const PERSONAL_FRAGMENTS = [
  'email', 'phone', 'iban', 'firstname', 'lastname', 'fullname', 'surname', 'nickname', 'username', 'birth', 'street', 'postal',
  'zipcode', 'address', 'ipaddr', 'clientip', 'remoteaddr', 'userip',
];
const PERSONAL_WORDS = new Set(['ip', 'ips', 'addr', 'tel', 'mobile', 'name', 'dob', 'login', 'ssn', 'zip', 'city', 'lat', 'lng', 'imei', 'bic']);
/** Names under which a 4–8 digit value is a one-time code. */
const OTP_CONTEXT_WORDS = new Set(['verification', 'verify', 'entered', 'input', 'confirm', 'challenge', 'digits', 'response', 'answer', 'otp', 'code', 'pin', 'tan']);

function nameWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a field NAME is sensitive (its value is never written). */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_NAMES.has(normalized)) return false;
  return SECRET_FRAGMENTS.some((f) => normalized.includes(f)) || nameWords(key).some((w) => SECRET_WORDS.has(w));
}

/** Whether a field NAME holds personal data (its value is replaced by a keyed fingerprint). */
export function isPersonalKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return PERSONAL_FRAGMENTS.some((f) => normalized.includes(f)) || nameWords(key).some((w) => PERSONAL_WORDS.has(w));
}

// ---------------------------------------------------------------------------------------------------------------------
// Values. A string is examined on several probes (cleaned, NFKC-normalized, percent-decoded); one hit replaces the
// WHOLE string by its fingerprint. Every pattern is anchored or bounded: the work is linear in the (≤ 1 KiB) input.
// ---------------------------------------------------------------------------------------------------------------------

/** Token prefixes of the apps and of common providers (in addition to `redactPath`'s list). */
const TOKEN_PREFIXES: readonly string[] = [
  ...SECRET_SEGMENT_PREFIXES, 'tk_', 'ctd_', 'mst_', 'ac_live_', 'ac_test_', 'sup_', 'sk-', 'pk_live_', 'pk_test_', 'rk_live_', 'rk_test_',
  'AIza', 'xapp-', 'xoxa-', 'xoxs-', 'xoxr-', 'npm_', 'SG.', 'AKIA', 'ASIA', 'hf_', 'gsk_', 'shpat_', 'pat-', 'dop_v1_', 'sq0',
];
const STRUCTURAL_SECRET_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./, // JWT
  /\bbearer\s{1,8}\S{8,}/i,
  /\bbasic\s{1,8}[A-Za-z0-9+/=]{8,}/i,
  /-----BEGIN [A-Z ]{0,40}-----/, // PEM block
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,256}:[^\s@/]{1,256}@/i, // credentials in a URL
  /(?:pass\w{0,16}|pwd|pw|mdp|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|pphrase|sid|session|cookie|auth\w{0,16}|otp|pin)["']?\s{0,8}[:=]\s{0,8}["']?[^\s"']{3,}/i,
  /\b(?:password|passwd|passphrase|pwd|mdp|secret)\s{1,8}(?:is\s{1,8}|was\s{1,8})?[^\s]{4,}/i, // "password X"
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/, // Telegram bot token
];
const CANDIDATE_RUN = /[A-Za-z0-9+/_.~=-]{8,}/g;
const BASE64_SUBRUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const SEGMENT_SUBRUN = /[A-Za-z0-9_\-.~+=]{20,}/g;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Zero-width characters and bidirectional controls: removed (they hide a token from the detectors or reorder text). */
const INVISIBLE_CHARS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/;
const IPV6_CANDIDATE = /[0-9A-Fa-f:]{3,45}/g;
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const STRICT_EMAIL = /(?<![^\s<>,;:"'()@])[^\s<>,;:"'()@]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![^\s<>,;:"'()@])/g;

function hasClasses(part: string): { upper: boolean; lower: boolean; digit: boolean; symbol: boolean; uppers: number } {
  const uppers = (part.match(/[A-Z]/g) ?? []).length;
  return { upper: uppers > 0, lower: /[a-z]/.test(part), digit: /[0-9]/.test(part), symbol: /[+/]/.test(part), uppers };
}

/** Random-looking base64 / base64url (≥ 20 characters): mixed classes, or both cases with many capitals (not camelCase). */
function looksBase64(part: string): boolean {
  const body = part.replace(/=+$/, '');
  if (body.length < 20 || !/^[A-Za-z0-9+/_-]+$/.test(body)) return false;
  const c = hasClasses(body);
  const classes = [c.upper, c.lower, c.digit, c.symbol].filter(Boolean).length;
  if (classes >= 3) return true;
  if (classes === 2 && (c.digit || c.symbol) && body.length >= 24) return true;
  return c.upper && c.lower && c.uppers / body.length >= 0.25;
}

/** Lower-case key with digits (≥ 16), or a run of ≥ 12 letters with too few vowels to be a word. */
function looksRandomWord(part: string): boolean {
  if (/^[a-z0-9]{16,}$/.test(part)) return /[0-9]/.test(part) && /[a-z]/.test(part);
  if (!/^[A-Za-z]{12,}$/.test(part)) return false;
  return (part.match(/[aeiouyAEIOUY]/g) ?? []).length / part.length < 0.25;
}

function isTokenLike(part: string): boolean {
  if (part.length < 8) return false;
  if (TOKEN_PREFIXES.some((prefix) => part.startsWith(prefix) && part.length >= prefix.length + 8)) return true;
  if (/^(?:0x)?[0-9a-fA-F]{12,}$/.test(part) && /[0-9]/.test(part) && /[a-fA-F]/.test(part)) return true;
  if (/^0x[0-9a-fA-F]{32,}$/.test(part) || /^[A-Z2-7]{16,}=*$/.test(part) || /^\d{16,}$/.test(part)) return true;
  // Password-like: ten characters or more mixing capitals, lower case and digits (identifiers like `OAuth2Client` are hit too).
  if (part.length >= 10 && /[A-Z]/.test(part) && /[a-z]/.test(part) && /[0-9]/.test(part)) return true;
  return looksRandomWord(part) || looksBase64(part);
}

function runLooksSecret(run: string): boolean {
  const candidates = [run, ...run.split(/[/.=:]/), ...(run.match(BASE64_SUBRUN) ?? []), ...(run.match(SEGMENT_SUBRUN) ?? [])];
  return candidates.some(isTokenLike);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  const candidates: string[] = text.match(CARD_CANDIDATE) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

function isIpv6(run: string): boolean {
  const colons = (run.match(/:/g) ?? []).length;
  if (colons < 2 || !(run.includes('::') || colons >= 5)) return false;
  return run.split(':').every((group) => group.length <= 4) && /[0-9A-Fa-f]/.test(run);
}

/** Twelve or more consecutive short lower-case words (a BIP39-like recovery phrase). */
function hasMnemonic(text: string): boolean {
  let run = 0;
  for (const word of text.split(/[\s,]+/)) {
    run = /^[a-z]{3,8}$/.test(word) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

/** An `@` that is not part of a plain e-mail address (`Summer@abcd1234`): the text is treated as a secret. */
function hasPseudoEmail(text: string): boolean {
  if (!text.includes('@')) return false;
  return text.replace(STRICT_EMAIL, ' ').includes('@');
}

function probeLooksSecret(probe: string): boolean {
  if (STRUCTURAL_SECRET_PATTERNS.some((pattern) => pattern.test(probe))) return true;
  if (IPV4.test(probe) || (probe.match(IPV6_CANDIDATE) ?? []).some(isIpv6)) return true;
  if (hasCardNumber(probe) || hasMnemonic(probe) || hasPseudoEmail(probe)) return true;
  return (probe.match(CANDIDATE_RUN) ?? []).some(runLooksSecret);
}

function cleanText(value: string): string {
  return value.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, ' ');
}

function probesOf(cleaned: string): string[] {
  const probes = [cleaned, cleaned.normalize('NFKC')];
  if (/%[0-9A-Fa-f]{2}/.test(cleaned)) {
    try {
      probes.push(decodeURIComponent(cleaned).normalize('NFKC'));
    } catch {
      return [...probes, cleaned.replace(/%[0-9A-Fa-f]{2}/g, '')];
    }
  }
  return probes;
}

/** Whether a free text contains something that looks like a secret or personal data (see the README for the list). */
export function looksSecret(text: string): boolean {
  if (text.length > TRACE_LIMITS.maxExaminedLength) return true;
  return probesOf(cleanText(text)).some(probeLooksSecret);
}

/**
 * A string fit for a trace: longer than 1 KiB or secret-looking ⇒ replaced as a whole by `hmac:<16 hex>;len=<n>`;
 * otherwise invisible and control characters removed, e-mail addresses masked (`j***@example.fr`), cut at 200.
 */
export function sanitizeTraceString(value: string): string {
  if (value.length > TRACE_LIMITS.maxExaminedLength || looksSecret(value)) return fingerprintWithLength(value);
  const masked = maskEmailAddresses(cleanText(value));
  const max = TRACE_LIMITS.maxStringLength;
  return masked.length > max ? `${masked.slice(0, max)}…[+${masked.length - max}]` : masked;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fields.
// ---------------------------------------------------------------------------------------------------------------------

function sanitizeScalar(value: unknown): TraceScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return !Number.isFinite(value) ? null : Number.isInteger(value) && Math.abs(value) >= 1e12 && hasCardNumber(String(Math.abs(value))) ? REDACTED : value;
  if (typeof value === 'bigint') return sanitizeTraceString(value.toString());
  if (typeof value === 'string') return sanitizeTraceString(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return '[error]';
  return Array.isArray(value) ? '[array]' : `[${typeof value}]`;
}

/** Value of a sensitive field: nothing of it but its kind and length. */
function redactValue(value: unknown): TraceScalar {
  if (value === null || value === undefined || typeof value === 'boolean') return (value ?? null) as TraceScalar;
  if (typeof value === 'string') return `${REDACTED.slice(0, -1)}:${value.length}]`;
  return REDACTED;
}

/** Value of a personal-data field (or an `id` field): its keyed fingerprint only. */
function pseudonymize(value: unknown): TraceScalar {
  if (value === null || value === undefined || typeof value === 'boolean') return (value ?? null) as TraceScalar;
  return typeof value === 'string' || typeof value === 'number' ? fingerprint(String(value)) : REDACTED;
}

function isOtpLike(key: string, value: unknown): boolean {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{4,8}$/.test(text) && nameWords(key).some((w) => OTP_CONTEXT_WORDS.has(w));
}

function sanitizeNamed(key: string, value: unknown): TraceValue {
  if (isSensitiveKey(key) || isOtpLike(key, value)) return Array.isArray(value) ? REDACTED : redactValue(value);
  if (isPersonalKey(key)) return Array.isArray(value) ? REDACTED : pseudonymize(value);
  if (!Array.isArray(value)) return sanitizeScalar(value);
  const items = value.slice(0, TRACE_LIMITS.maxArrayItems).map((item) => (Array.isArray(item) ? '[array]' : sanitizeScalar(item)));
  return value.length > TRACE_LIMITS.maxArrayItems ? [...items, `[+${value.length - TRACE_LIMITS.maxArrayItems}]`] : items;
}

/** A declared field: its type first (enumerations kept verbatim, `id` fingerprinted), then the name and value rules. */
function sanitizeDeclared(key: string, type: TraceFieldType, value: unknown): TraceValue | undefined {
  if (value === null || value === undefined) return null;
  if (Array.isArray(type)) return typeof value === 'string' && type.includes(value) ? value : undefined;
  if (type === 'id') return pseudonymize(value);
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number') return typeof value === 'number' ? sanitizeNamed(key, value) : undefined;
  return typeof value === 'string' ? sanitizeNamed(key, value) : undefined;
}

function acceptableKey(key: string): boolean {
  return key.length <= TRACE_LIMITS.maxKeyLength && KEY_NAME.test(key) && !looksSecret(key);
}

/**
 * Sanitized copy of trace fields under the `rules` of the check (from its `checks.json`): a field the rules do not
 * declare is dropped (`_droppedFields` counts them); `null` rules (undeclared trace) drop every field. Then the safety
 * net: sensitive names redacted, personal data fingerprinted, secret-looking strings fingerprinted, e-mails masked,
 * simple values only, sizes capped. Pure; never throws (getters that throw are dropped).
 */
export function sanitizeTraceFields(fields: unknown, rules: TraceFieldRules | null): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  let dropped = 0;
  for (const key of Object.keys(fields)) {
    try {
      const declared = rules === '*' ? undefined : rules?.[key];
      const allowed = rules === '*' ? acceptableKey(key) : declared !== undefined && Object.prototype.hasOwnProperty.call(rules, key);
      const raw = allowed && Object.keys(out).length < TRACE_LIMITS.maxFields ? (fields as Record<string, unknown>)[key] : undefined;
      const value = !allowed || raw === undefined ? undefined : declared === undefined ? sanitizeNamed(key, raw) : sanitizeDeclared(key, declared, raw);
      if (value === undefined) dropped += 1;
      else out[key] = value;
    } catch {
      dropped += 1;
    }
  }
  if (dropped) out._droppedFields = dropped;
  return out;
}
