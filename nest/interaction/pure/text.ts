/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Texts carried by the module (invariant 10): only the summary the caller gives, cleaned of control characters, masked
// (`maskKnownSecrets`) and cut. Pure.

import { maskKnownSecrets } from '../utils/maskKnownSecrets';
import type { InteractionText } from '../types/interactionTypes';

export const TITLE_MAX = 120;
export const BODY_MAX = 1000;
export const FIELD_VALUE_MAX = 200;
export const PARAM_VALUE_MAX = 200;
export const TEXT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
export const PARAM_NAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const MAX_PARAMS = 12;
const RAW_MAX = 4000;

// Control characters other than tab and newline (C0, DEL, C1).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** CRLF → LF, control characters removed, trimmed. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
}

/** Cut to `max` characters (code points), the last one replaced by `…`; never in the middle of a surrogate pair. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Clean, mask, cut: what every text of the module goes through before it is stored or rendered. */
export function safeText(text: string, max: number): string {
  return truncate(maskKnownSecrets(cleanText(text)), max);
}

/** `{name}` placeholders replaced by `params[name]` (a missing parameter stays visible). */
export function fillParams(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]{1,32})\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function isRawText(text: InteractionText): text is { raw: string } {
  return typeof (text as { raw?: unknown }).raw === 'string';
}

/**
 * An `InteractionText` checked and made safe for storage: a raw text cleaned, masked and cut to `rawMax`; a key
 * checked (`TEXT_KEY_PATTERN`) with at most 12 parameters, each value masked and cut. `null` when malformed.
 */
export function sanitizeText(input: unknown, rawMax = RAW_MAX): InteractionText | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = (input as { raw?: unknown }).raw;
  if (typeof raw === 'string') {
    const text = safeText(raw, rawMax);
    return text === '' ? null : { raw: text };
  }
  const key = (input as { key?: unknown }).key;
  if (typeof key !== 'string' || !TEXT_KEY_PATTERN.test(key)) return null;
  const params = (input as { params?: unknown }).params;
  if (params === undefined || params === null) return { key };
  if (typeof params !== 'object' || Array.isArray(params)) return null;
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > MAX_PARAMS) return null;
  const clean: Record<string, string | number> = {};
  for (const [name, value] of entries) {
    if (!PARAM_NAME_PATTERN.test(name)) return null;
    if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value;
    else if (typeof value === 'string') clean[name] = safeText(value, PARAM_VALUE_MAX);
    else return null;
  }
  return { key, params: clean };
}

/** Renders a text with `translate(key)` (the template in the recipient's language), then masks and cuts it. */
export async function renderText(text: InteractionText, translate: (key: string) => Promise<string>, max: number): Promise<string> {
  if (isRawText(text)) return safeText(text.raw, max);
  const template = await translate(text.key);
  return safeText(fillParams(template, text.params), max);
}

/** A relative path of the app (`/x/y?z`), or null: no scheme, no `//host`, no backslash, 512 characters at most. */
export function sanitizeRelativeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (url.length === 0 || url.length > 512 || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(url)) return null;
  return url;
}
