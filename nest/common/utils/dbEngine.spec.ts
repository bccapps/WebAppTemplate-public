/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { resolveEngine } from './dbEngine';

describe('resolveEngine', () => {
  const KEYS = ['DB_ENGINE', 'DATABASE_ENGINE', 'DB__ARCHIVE__ENGINE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to postgres and lower-cases DB_ENGINE', () => {
    expect(resolveEngine()).toBe('postgres');
    process.env.DB_ENGINE = 'SQLite';
    expect(resolveEngine()).toBe('sqlite');
  });

  it('reads a named connection from DB__<NAME>__ENGINE', () => {
    process.env.DB_ENGINE = 'sqlite';
    process.env.DB__ARCHIVE__ENGINE = 'neon';
    expect(resolveEngine('archive')).toBe('neon');
  });

  it('refuses the removed DATABASE_ENGINE instead of silently using postgres', () => {
    process.env.DATABASE_ENGINE = 'supabase';
    expect(() => resolveEngine()).toThrow(/DATABASE_ENGINE is no longer supported/);
    process.env.DB_ENGINE = 'supabase';
    expect(resolveEngine()).toBe('supabase');
  });
});
