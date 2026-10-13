/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AuthPrincipal } from '../auth';
import type { EventAudience, TopicMatch } from './types';

/** True when the audience names at least one recipient class (an empty audience reaches nobody). */
export function hasAudience(audience: EventAudience | null | undefined): boolean {
  if (!audience) return false;
  return (
    audience.userId !== undefined ||
    audience.tenantId !== undefined ||
    audience.admin === true ||
    audience.public === true
  );
}

/** Every present field must match; no field at all means nobody (no implicit broadcast). */
export function matchesAudience(audience: EventAudience, principal: AuthPrincipal): boolean {
  if (!hasAudience(audience)) return false;
  if (audience.userId !== undefined && principal.id !== audience.userId) return false;
  if (audience.tenantId !== undefined && String(principal['tenantId']) !== String(audience.tenantId)) return false;
  if (audience.admin === true && principal.admin !== true) return false;
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles `ocr.document:*` (the wildcard matches one or more characters) into a matcher. */
export function compileTopicPattern(pattern: string): (topic: string) => TopicMatch | null {
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('(.+?)') + '$');
  return (topic: string): TopicMatch | null => {
    const m = regex.exec(topic);
    return m ? { topic, key: m[1] ?? '' } : null;
  };
}
