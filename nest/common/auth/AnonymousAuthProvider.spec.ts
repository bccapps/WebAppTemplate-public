/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { AnonymousAuthProvider } from './AnonymousAuthProvider';

const LONG = 'a'.repeat(40);

describe('AnonymousAuthProvider', () => {
  const saved = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = saved;
  });

  it('accepts the correct token as admin-token principal', async () => {
    process.env.ADMIN_TOKEN = LONG;
    const p = new AnonymousAuthProvider();
    expect(p.mode).toBe('anonymous');
    await expect(p.resolveToken(LONG)).resolves.toEqual({ id: 0, admin: true, kind: 'admin-token' });
  });

  it('rejects a wrong token of the same length', async () => {
    process.env.ADMIN_TOKEN = LONG;
    await expect(new AnonymousAuthProvider().resolveToken('b'.repeat(40))).resolves.toBeNull();
  });

  it('rejects a token of a different length', async () => {
    process.env.ADMIN_TOKEN = LONG;
    await expect(new AnonymousAuthProvider().resolveToken(LONG + 'a')).resolves.toBeNull();
  });

  it('rejects everything when ADMIN_TOKEN is empty', async () => {
    process.env.ADMIN_TOKEN = '';
    const p = new AnonymousAuthProvider();
    await expect(p.resolveToken('')).resolves.toBeNull();
    await expect(p.resolveToken('x')).resolves.toBeNull();
  });

  it('rejects everything when ADMIN_TOKEN is shorter than 32 characters', async () => {
    process.env.ADMIN_TOKEN = 'short-token';
    await expect(new AnonymousAuthProvider().resolveToken('short-token')).resolves.toBeNull();
  });
});
