/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** en and fr carry the same keys; every literal key of the sources, and one label per error code, exists. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { INTERACTION_ERROR_CODES } from '../types/interactionTypes';

const root = join(__dirname, '..');
const read = (lang: string) => JSON.parse(readFileSync(join(__dirname, `locales.${lang}.json`), 'utf8')) as Record<string, string>;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

describe('interaction front locales', () => {
  const en = read('en');
  const fr = read('fr');

  it('en and fr have the same keys', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it('every literal key used by the components exists', () => {
    const used = new Set<string>();
    for (const file of sources(root)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`](interaction\.[A-Za-z0-9_.]+[A-Za-z0-9_])['"`]/g)) used.add(match[1]);
    used.delete(INBOX_TOPIC);
    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((key) => !en[key])).toEqual([]);
  });

  it('one label per error code, and for every dynamic family', () => {
    for (const code of [...INTERACTION_ERROR_CODES, 'UNKNOWN']) expect(en[`interaction.errors.${code}`]).toBeDefined();
    for (const category of ['security', 'approval', 'info']) expect(en[`interaction.categories.${category}`]).toBeDefined();
    for (const status of ['answered', 'expired', 'cancelled']) expect(en[`interaction.modal.outcome.${status}`]).toBeDefined();
    for (const permission of ['granted', 'denied', 'default', 'unsupported']) expect(en[`interaction.channels.browser.permission.${permission}`]).toBeDefined();
    for (const kind of ['inapp', 'browser', 'telegram', 'email', 'webhook']) expect(en[`interaction.channels.${kind}.title`]).toBeDefined();
    for (const column of ['kind', 'owner', 'state', 'verified', 'lastTest', 'lastError', 'actions']) expect(en[`interaction.admin.columns.${column}`]).toBeDefined();
  });
});

const INBOX_TOPIC = 'interaction.inbox';
