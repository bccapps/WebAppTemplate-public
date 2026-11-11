/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Texts of the module on the front: an `InteractionText` is a translation key with NAMED parameters (`{name}`), or a
// text the server already rendered (`raw`). React escapes the result: never HTML.

import type { InteractionText } from '../types/interactionTypes';

/** `{name}` placeholders replaced by `params[name]` (a missing parameter stays visible). */
export function fillParams(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]{1,32})\}/g, (match, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

/** The text in the current language (`translate` = `i18n.get`). A missing key shows as the key (template rule). */
export function renderText(text: InteractionText | null | undefined, translate: (key: string) => string): string {
  if (!text) return '';
  if ('raw' in text && typeof text.raw === 'string') return text.raw;
  if ('key' in text && typeof text.key === 'string') return fillParams(translate(text.key), text.params);
  return '';
}

/** Seconds left until `expiresAt` (never negative). */
export function secondsLeft(expiresAt: string, now: number): number {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((at - now) / 1000));
}

/** `mm:ss`, or `h:mm:ss` from an hour. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${pad(minutes)}:${pad(s % 60)}`;
}

/** A same-origin app path from a notification's data (never another origin, never a scheme). */
export function safeAppPath(url: unknown, origin: string): string {
  if (typeof url !== 'string' || url === '') return '/';
  try {
    const target = new URL(url, origin);
    return target.origin === origin ? `${target.pathname}${target.search}${target.hash}` : '/';
  } catch {
    return '/';
  }
}
