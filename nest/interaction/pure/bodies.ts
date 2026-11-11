/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Server-side validation of the HTTP bodies and parameters of the module (04 §11), independent of the app's
// `ValidationPipe` (which may be absent or validate only). Unknown fields are ignored. Throws `InteractionError`
// (`INVALID_INPUT { field }`, `ROUTE_REQUIRED`).

import { InteractionError } from '../errors/InteractionError';
import { CHANNEL_KIND_PATTERN, INTERACTION_CATEGORIES, type InteractionCategory } from '../types/interactionTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function invalid(field: string): never {
  throw new InteractionError('INVALID_INPUT', { field });
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InteractionError('NOT_FOUND');
  return value.toLowerCase();
}

/** A channel kind of a path (`inapp` is not configurable: `NOT_FOUND`). */
export function parseKind(value: unknown): string {
  if (typeof value !== 'string' || !CHANNEL_KIND_PATTERN.test(value) || value === 'inapp') throw new InteractionError('NOT_FOUND');
  return value;
}

export function parseUserId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) invalid('userId');
  return id;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

/** `PATCH /me/channels/:kind`: `{ enabled?, position? }`. */
export function parseChannelState(body: unknown): { enabled?: boolean; position?: number } {
  const input = record(body);
  const enabled = optionalBoolean(input, 'enabled');
  const position = input.position;
  if (position !== undefined && (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > 1000)) invalid('position');
  if (enabled === undefined && position === undefined) invalid('body');
  return { ...(enabled !== undefined ? { enabled } : {}), ...(position !== undefined ? { position: position as number } : {}) };
}

/** `POST /me/tickets/:id/answer`: `{ actionId, stepUpProof? }`. */
export function parseAnswerBody(body: unknown): { actionId: string; stepUpProof: string | null } {
  const input = record(body);
  if (typeof input.actionId !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/.test(input.actionId)) invalid('actionId');
  const proof = input.stepUpProof;
  if (proof !== undefined && proof !== null && (typeof proof !== 'string' || proof.length === 0 || proof.length > 128)) invalid('stepUpProof');
  return { actionId: input.actionId, stepUpProof: typeof proof === 'string' ? proof : null };
}

/** `POST /me/notices/read`: `{ ids }` (100 at most) or `{ all: true }`. */
export function parseReadBody(body: unknown): string[] | 'all' {
  const input = record(body);
  if (input.all === true) return 'all';
  if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 100) invalid('ids');
  return input.ids.map((id) => {
    if (typeof id !== 'string' || !UUID.test(id)) invalid('ids');
    return id.toLowerCase();
  });
}

/** Length of the `p256dh` / `auth` columns (`varchar(256)`): a key is refused beyond, never truncated nor overflowed. */
export const WEB_PUSH_KEY_MAX = 256;

export interface WebPushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
}

/**
 * `POST /me/webpush/subscriptions`: an `https` endpoint of 2 048 characters at most, the two keys (base64url, 256
 * characters at most PADDING INCLUDED: the columns are `varchar(256)`, review F6), a user agent ≤ 256.
 */
export function parseWebPushSubscribe(body: unknown): WebPushSubscribeBody {
  const input = record(body);
  const endpoint = input.endpoint;
  let url: URL | null;
  try {
    url = typeof endpoint === 'string' && endpoint.length <= 2048 ? new URL(endpoint) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password) invalid('endpoint');
  const keys = record(input.keys);
  const shape = /^[A-Za-z0-9_-]+={0,2}$/;
  const fits = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= WEB_PUSH_KEY_MAX && shape.test(value);
  if (!fits(keys.p256dh) || !fits(keys.auth)) invalid('keys');
  const userAgent = input.userAgent;
  if (userAgent !== undefined && userAgent !== null && (typeof userAgent !== 'string' || userAgent.length > 256)) invalid('userAgent');
  return { endpoint: url.toString(), keys: { p256dh: keys.p256dh as string, auth: keys.auth as string }, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

export function parseEndpointBody(body: unknown): string {
  const endpoint = record(body).endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) invalid('endpoint');
  return endpoint;
}

export interface PrefPatch {
  quietHours?: { start: string; end: string } | null;
  timezone?: string | null;
  criticalBypass?: boolean;
  routing?: Partial<Record<InteractionCategory, string[] | null>>;
  inappDisplay?: 'toast' | 'browser' | null;
}

function parseQuietHours(value: unknown): { start: string; end: string } | null {
  if (value === null) return null;
  const input = record(value);
  if (typeof input.start !== 'string' || typeof input.end !== 'string' || !HHMM.test(input.start) || !HHMM.test(input.end) || input.start === input.end) invalid('quietHours');
  return { start: input.start, end: input.end };
}

function parseRouting(value: unknown): Partial<Record<InteractionCategory, string[] | null>> {
  const input = record(value);
  const out: Partial<Record<InteractionCategory, string[] | null>> = {};
  for (const category of INTERACTION_CATEGORIES) {
    if (!(category in input)) continue;
    const kinds = input[category];
    if (kinds === null) {
      out[category] = null;
      continue;
    }
    if (!Array.isArray(kinds) || kinds.length > 10 || !kinds.every((kind) => typeof kind === 'string' && (kind === 'inapp' || CHANNEL_KIND_PATTERN.test(kind)))) invalid(`routing.${category}`);
    // 04 §11.1: approval / security can never be routed to nothing.
    if (kinds.length === 0 && category !== 'info') throw new InteractionError('ROUTE_REQUIRED', { category });
    out[category] = [...new Set(kinds as string[])];
  }
  return out;
}

/** `PUT /me/prefs`: every field optional. */
export function parsePrefBody(body: unknown, isTimeZone: (zone: string) => boolean): PrefPatch {
  const input = record(body);
  const patch: PrefPatch = {};
  if ('quietHours' in input) patch.quietHours = parseQuietHours(input.quietHours);
  if ('timezone' in input) {
    const zone = input.timezone;
    if (zone !== null && (typeof zone !== 'string' || !isTimeZone(zone))) invalid('timezone');
    patch.timezone = zone as string | null;
  }
  const bypass = optionalBoolean(input, 'criticalBypass');
  if (bypass !== undefined) patch.criticalBypass = bypass;
  if ('routing' in input) patch.routing = parseRouting(input.routing);
  if ('inappDisplay' in input) {
    const display = input.inappDisplay;
    if (display !== null && display !== 'toast' && display !== 'browser') invalid('inappDisplay');
    patch.inappDisplay = display as 'toast' | 'browser' | null;
  }
  return patch;
}

export function parseAdminDisable(body: unknown): boolean {
  const value = record(body).adminDisabled;
  if (typeof value !== 'boolean') invalid('adminDisabled');
  return value;
}

/** A short reason code (`[a-z0-9_.-]`, 64 at most), never free text. */
export function parseReason(body: unknown): string {
  const reason = record(body).reason;
  if (typeof reason !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(reason)) invalid('reason');
  return reason;
}

export function parseVerifyBody(body: unknown): string {
  const code = record(body).code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 32) invalid('code');
  return code;
}

/** Optional filters of the admin lists. */
export function optionalString(value: unknown, pattern: RegExp): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) invalid('filter');
  return value;
}

export function optionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) invalid('date');
  return date;
}
