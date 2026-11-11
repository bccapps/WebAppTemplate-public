/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Validation of what an app hands to the module (04 §4.2, §4.3). Pure; throws `InteractionError` with the field name
// only (`INVALID_NOTICE` / `INVALID_QUESTION`, `details: { field }`). Every text comes back cleaned and masked.

import { InteractionError } from '../errors/InteractionError';
import {
  CHANNEL_KIND_PATTERN,
  INTERACTION_CATEGORIES,
  type InteractionAction,
  type InteractionCategory,
  type InteractionPriority,
  type InteractionProof,
  type InteractionQuestion,
  type InteractionSummary,
  type InteractionText,
  type UserNotice,
} from '../types/interactionTypes';
import { BODY_MAX, FIELD_VALUE_MAX, TITLE_MAX, safeText, sanitizeRelativeUrl, sanitizeText } from './text';

export const NOTICE_TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/;
export const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;
export const QUESTION_KIND_PATTERN = /^[a-z0-9]+(\.[a-z0-9_]+){0,4}$/;
const DEDUP_KEY_MAX = 128;
const CORRELATION_MAX = 128;
const DATA_MAX_BYTES = 2048;
const SUMMARY_MAX_BYTES = 4096;
const MAX_FIELDS = 12;
const ACTION_STYLES = ['primary', 'danger', 'neutral'];

/** A notice once validated: the texts made safe, the defaults applied. */
export interface CleanNotice {
  type: string;
  source: string;
  category: InteractionCategory;
  priority: InteractionPriority;
  title: InteractionText;
  body: InteractionText | null;
  url: string | null;
  dedupKey: string | null;
  data: Record<string, string | number | boolean> | null;
}

function fail(code: 'INVALID_NOTICE' | 'INVALID_QUESTION', field: string): never {
  throw new InteractionError(code, { field });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanData(value: unknown): Record<string, string | number | boolean> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('INVALID_NOTICE', 'data');
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(value);
  if (entries.length > 32) fail('INVALID_NOTICE', 'data');
  for (const [name, item] of entries) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) fail('INVALID_NOTICE', 'data');
    if (typeof item === 'string' && item.length > 256) fail('INVALID_NOTICE', 'data');
    if (typeof item === 'string') out[name] = safeText(item, 256);
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) out[name] = item;
    else fail('INVALID_NOTICE', 'data');
  }
  if (Buffer.byteLength(JSON.stringify(out)) > DATA_MAX_BYTES) fail('INVALID_NOTICE', 'data');
  return out;
}

function optionalUrl(value: unknown, code: 'INVALID_NOTICE' | 'INVALID_QUESTION', field: string): string | null {
  if (value === undefined || value === null) return null;
  const url = sanitizeRelativeUrl(value);
  if (url === null) fail(code, field);
  return url;
}

/** `UserNotice` → `CleanNotice`, or `INVALID_NOTICE { field }`. */
export function validateNotice(notice: UserNotice): CleanNotice {
  if (!isRecord(notice)) fail('INVALID_NOTICE', 'notice');
  if (typeof notice.type !== 'string' || notice.type.length > 64 || !NOTICE_TYPE_PATTERN.test(notice.type)) fail('INVALID_NOTICE', 'type');
  if (typeof notice.source !== 'string' || !SOURCE_PATTERN.test(notice.source)) fail('INVALID_NOTICE', 'source');
  if (!INTERACTION_CATEGORIES.includes(notice.category)) fail('INVALID_NOTICE', 'category');
  const priority = notice.priority ?? 'normal';
  if (priority !== 'normal' && priority !== 'critical') fail('INVALID_NOTICE', 'priority');
  const title = sanitizeText(notice.title, TITLE_MAX);
  if (!title) fail('INVALID_NOTICE', 'title');
  const body = notice.body === undefined || notice.body === null ? null : sanitizeText(notice.body, BODY_MAX);
  if (notice.body !== undefined && notice.body !== null && !body) fail('INVALID_NOTICE', 'body');
  const dedupKey = notice.dedupKey === undefined || notice.dedupKey === null ? null : notice.dedupKey;
  if (dedupKey !== null && (typeof dedupKey !== 'string' || dedupKey.length === 0 || dedupKey.length > DEDUP_KEY_MAX)) fail('INVALID_NOTICE', 'dedupKey');
  return {
    type: notice.type,
    source: notice.source,
    category: notice.category,
    priority,
    title,
    body,
    url: optionalUrl(notice.url, 'INVALID_NOTICE', 'url'),
    dedupKey,
    data: cleanData(notice.data),
  };
}

/** A question once validated. */
export interface CleanQuestion {
  kind: string;
  source: string;
  correlationId: string;
  category: 'approval' | 'security';
  summary: InteractionSummary;
  actions: InteractionAction[];
  expiresAt: Date;
  answerableFrom: string[] | null;
  freshProof: boolean;
}

function cleanSummary(summary: unknown): InteractionSummary {
  if (!isRecord(summary)) fail('INVALID_QUESTION', 'summary');
  const title = sanitizeText(summary.title, TITLE_MAX);
  if (!title) fail('INVALID_QUESTION', 'summary.title');
  const out: InteractionSummary = { title };
  if (summary.body !== undefined && summary.body !== null) {
    const body = sanitizeText(summary.body, BODY_MAX);
    if (!body) fail('INVALID_QUESTION', 'summary.body');
    out.body = body;
  }
  if (summary.fields !== undefined && summary.fields !== null) {
    if (!Array.isArray(summary.fields) || summary.fields.length > MAX_FIELDS) fail('INVALID_QUESTION', 'summary.fields');
    out.fields = summary.fields.map((field: unknown) => {
      if (!isRecord(field) || typeof field.value !== 'string') fail('INVALID_QUESTION', 'summary.fields');
      const label = sanitizeText(field.label, 80);
      if (!label) fail('INVALID_QUESTION', 'summary.fields');
      return { label, value: safeText(field.value, FIELD_VALUE_MAX) };
    });
  }
  const url = optionalUrl(summary.url, 'INVALID_QUESTION', 'summary.url');
  if (url) out.url = url;
  if (Buffer.byteLength(JSON.stringify(out)) > SUMMARY_MAX_BYTES) fail('INVALID_QUESTION', 'summary');
  return out;
}

function cleanActions(actions: unknown): InteractionAction[] {
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > 4) fail('INVALID_QUESTION', 'actions');
  const ids = new Set<string>();
  return actions.map((action: unknown) => {
    if (!isRecord(action) || typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id) || ids.has(action.id)) fail('INVALID_QUESTION', 'actions');
    if (typeof action.style !== 'string' || !ACTION_STYLES.includes(action.style)) fail('INVALID_QUESTION', 'actions');
    const label = sanitizeText(action.label, 40);
    if (!label) fail('INVALID_QUESTION', 'actions');
    ids.add(action.id);
    return { id: action.id, label, style: action.style as InteractionAction['style'] };
  });
}

function cleanKinds(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) fail('INVALID_QUESTION', 'answerableFrom');
  const kinds = new Set<string>();
  for (const kind of value) {
    if (typeof kind !== 'string' || !(kind === 'inapp' || CHANNEL_KIND_PATTERN.test(kind))) fail('INVALID_QUESTION', 'answerableFrom');
    kinds.add(kind);
  }
  return [...kinds];
}

/** `InteractionQuestion` → `CleanQuestion`, or `INVALID_QUESTION { field }`. `expiresAt` must be in (now, now + maxTtl]. */
export function validateQuestion(question: InteractionQuestion, options: { now: Date; maxTtlSeconds: number }): CleanQuestion {
  if (!isRecord(question)) fail('INVALID_QUESTION', 'question');
  if (typeof question.kind !== 'string' || question.kind.length > 64 || !QUESTION_KIND_PATTERN.test(question.kind)) fail('INVALID_QUESTION', 'kind');
  if (typeof question.source !== 'string' || !SOURCE_PATTERN.test(question.source)) fail('INVALID_QUESTION', 'source');
  if (typeof question.correlationId !== 'string' || question.correlationId.length === 0 || question.correlationId.length > CORRELATION_MAX) fail('INVALID_QUESTION', 'correlationId');
  if (question.category !== 'approval' && question.category !== 'security') fail('INVALID_QUESTION', 'category');
  const expiresAt = question.expiresAt instanceof Date ? question.expiresAt : new Date(Number.NaN);
  const now = options.now.getTime();
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now || expiresAt.getTime() > now + options.maxTtlSeconds * 1000) fail('INVALID_QUESTION', 'expiresAt');
  if (question.freshProof !== undefined && typeof question.freshProof !== 'boolean') fail('INVALID_QUESTION', 'freshProof');
  return {
    kind: question.kind,
    source: question.source,
    correlationId: question.correlationId,
    category: question.category,
    summary: cleanSummary(question.summary),
    actions: cleanActions(question.actions),
    expiresAt,
    answerableFrom: cleanKinds(question.answerableFrom),
    freshProof: question.freshProof === true,
  };
}

/** A channel as `answerableKinds` sees it: may it `reply`, and how can it bring a proof (04 §22). */
export interface AnswerChannel {
  kind: string;
  reply: boolean;
  proof: InteractionProof;
}

/** 04 §22: only a channel whose interface is inside the authenticated app answers a `freshProof` question (v1: not `code`). */
export function bringsFreshProof(proof: InteractionProof | null | undefined): boolean {
  return proof === 'in_app';
}

/**
 * The kinds that may answer a question: the requested ones (default: every kind with the `reply` capability), restricted
 * to the `reply` kinds; for a `freshProof` question, further restricted to the kinds whose declared `proof` is `in_app`
 * (04 §21.4 revised by §22: `link` channels only lead into the app). Never empty: `inapp`.
 */
export function answerableKinds(requested: string[] | null, channels: readonly AnswerChannel[], freshProof: boolean): string[] {
  const reply = channels.filter((channel) => channel.reply);
  const allowed = new Set(reply.filter((channel) => !freshProof || bringsFreshProof(channel.proof)).map((channel) => channel.kind));
  const wanted = requested ?? reply.map((channel) => channel.kind);
  const kinds = wanted.filter((kind) => allowed.has(kind));
  return kinds.length > 0 ? kinds : ['inapp'];
}

/** 1 to `max` distinct positive integer ids, or `INVALID_QUESTION { field: 'recipients' }`. */
export function normalizeRecipients(recipients: number | number[], max: number, code: 'INVALID_QUESTION' | 'INVALID_NOTICE' = 'INVALID_QUESTION'): number[] {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const ids = [...new Set(list)];
  if (ids.length === 0 || ids.length > max || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) fail(code, 'recipients');
  return ids;
}
