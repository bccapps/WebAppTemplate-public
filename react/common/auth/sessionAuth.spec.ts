/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./adminTokenAuth', () => ({
  adminTokenAuth: {
    mode: 'anonymous',
    isAuth: () => false,
    isAdmin: () => false,
    get: () => null,
    clear: vi.fn(),
    setLocale: vi.fn(),
    detectLocalTrust: vi.fn(async () => true),
  },
}));

import { appSession } from '../core/session/AppSession';
import { detectLocalTrust, isUserManagementEnabled, registerSessionAuth, sessionAuth, type SessionAuthPort } from './sessionAuth';
import { adminTokenAuth } from './adminTokenAuth';

function makePort(): SessionAuthPort {
  return {
    mode: 'users',
    isAuth: vi.fn(() => true),
    isAdmin: vi.fn(() => true),
    get: vi.fn(() => ({ id: 7, admin: true, email: 'a@b.c' })),
    clear: vi.fn(),
    setLocale: vi.fn(),
  };
}

describe('sessionAuth', () => {
  beforeEach(() => {
    registerSessionAuth(adminTokenAuth);
  });

  it('defaults to anonymous mode', () => {
    expect(sessionAuth.mode).toBe('anonymous');
    expect(isUserManagementEnabled()).toBe(false);
    expect(sessionAuth.isAdmin()).toBe(false);
  });

  it('detects local trust through the anonymous port only', async () => {
    await expect(detectLocalTrust()).resolves.toBe(true);
    registerSessionAuth(makePort());
    await expect(detectLocalTrust()).resolves.toBe(false);
    expect(adminTokenAuth.detectLocalTrust).toHaveBeenCalledTimes(1);
  });

  it('delegates to the registered port', () => {
    const port = makePort();
    registerSessionAuth(port);
    expect(sessionAuth.mode).toBe('users');
    expect(isUserManagementEnabled()).toBe(true);
    expect(sessionAuth.isAuth()).toBe(true);
    expect(sessionAuth.get()?.email).toBe('a@b.c');
    sessionAuth.setLocale('fr');
    sessionAuth.clear();
    expect(port.setLocale).toHaveBeenCalledWith('fr');
    expect(port.clear).toHaveBeenCalled();
  });

  it('last registration wins', () => {
    const first = makePort();
    const second = makePort();
    registerSessionAuth(first);
    registerSessionAuth(second);
    sessionAuth.clear();
    expect(first.clear).not.toHaveBeenCalled();
    expect(second.clear).toHaveBeenCalled();
  });

  it("emits appSession 'user' on registration", () => {
    const listener = vi.fn();
    const id = appSession.addEventListener('user', listener);
    registerSessionAuth(makePort());
    appSession.removeEventListerner(id);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
