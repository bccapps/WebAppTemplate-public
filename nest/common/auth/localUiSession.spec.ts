/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash, randomBytes } from 'node:crypto';
import { AnonymousAuthProvider } from './AnonymousAuthProvider';
import {
  DEFAULT_GRACE_MS,
  DEFAULT_RENEW_AFTER_MS,
  DEFAULT_TTL_MS,
  LocalUiSessionStore,
  isLocalUiBootAnchor,
  localUiSessionStore,
  localUiSessionToken,
  resetLocalUiSessionStoreForTests,
} from './localUiSession';

// Fake boot codes built at run time (never a real secret).
function bootPair(): { code: string; anchor: string } {
  const code = randomBytes(32).toString('hex');
  return { code, anchor: createHash('sha256').update(code, 'utf8').digest('hex') };
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('LocalUiSessionStore', () => {
  it('exchanges the boot code once for a token; a replayed or wrong code is refused', () => {
    const { code, anchor } = bootPair();
    const store = new LocalUiSessionStore(anchor);
    expect(store.bootPending).toBe(true);
    expect(store.exchange(bootPair().code)).toBeNull();
    expect(store.bootPending).toBe(true);
    const issued = store.exchange(code);
    expect(issued).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), ttlMs: DEFAULT_TTL_MS, renewAfterMs: DEFAULT_RENEW_AFTER_MS });
    expect(store.bootPending).toBe(false);
    expect(store.exchange(code)).toBeNull();
    expect(store.verify(issued!.token)).toBe(true);
  });

  it('refuses malformed codes and tokens without throwing', () => {
    const { anchor } = bootPair();
    const store = new LocalUiSessionStore(anchor);
    for (const bad of [undefined, null, 42, '', 'zz', anchor, `${'a'.repeat(63)}g`, ['x']]) {
      if (bad === anchor) continue;
      expect(store.exchange(bad)).toBeNull();
      expect(store.verify(bad)).toBe(false);
      expect(store.renew(bad)).toBeNull();
    }
    // The anchor itself is not the code (its preimage is).
    expect(store.exchange(anchor)).toBeNull();
  });

  it('expires a token after its life on the monotonic clock', () => {
    const { code, anchor } = bootPair();
    const time = clock();
    const store = new LocalUiSessionStore(anchor, { ttlMs: 1_000, now: time.now });
    const { token } = store.exchange(code)!;
    time.advance(999);
    expect(store.verify(token)).toBe(true);
    time.advance(1);
    expect(store.verify(token)).toBe(false);
    expect(store.renew(token)).toBeNull();
  });

  it('rotates: the renewed token passes a grace period only, the new one lives a full life', () => {
    const { code, anchor } = bootPair();
    const time = clock();
    const store = new LocalUiSessionStore(anchor, { ttlMs: 10_000, graceMs: 100, now: time.now });
    const first = store.exchange(code)!.token;
    const second = store.renew(first)!.token;
    expect(second).not.toBe(first);
    expect(store.verify(first)).toBe(true);
    time.advance(100);
    expect(store.verify(first)).toBe(false);
    expect(store.verify(second)).toBe(true);
    time.advance(9_899);
    expect(store.verify(second)).toBe(true);
  });

  it('a renewal never extends the token it replaces', () => {
    const { code, anchor } = bootPair();
    const time = clock();
    const store = new LocalUiSessionStore(anchor, { ttlMs: 1_000, graceMs: DEFAULT_GRACE_MS, now: time.now });
    const first = store.exchange(code)!.token;
    time.advance(950);
    store.renew(first);
    time.advance(50);
    expect(store.verify(first)).toBe(false);
  });

  it('keeps a bounded number of live tokens, dropping the oldest', () => {
    const { code, anchor } = bootPair();
    const store = new LocalUiSessionStore(anchor, { maxSessions: 2 });
    const first = store.exchange(code)!.token;
    const second = store.renew(first)!.token;
    const third = store.renew(second)!.token;
    expect(store.verify(first)).toBe(false);
    expect(store.verify(second)).toBe(true);
    expect(store.verify(third)).toBe(true);
  });

  it('refuses a malformed anchor (fail closed)', () => {
    for (const bad of ['', 'abc', 'g'.repeat(64)]) expect(() => new LocalUiSessionStore(bad)).toThrow(/LOCAL_UI_BOOT_ANCHOR/);
    expect(isLocalUiBootAnchor(bootPair().anchor)).toBe(true);
    expect(isLocalUiBootAnchor(undefined)).toBe(false);
  });
});

describe('localUiSessionStore (process store)', () => {
  afterEach(() => resetLocalUiSessionStoreForTests());

  it('exists only with LOCAL_TRUST and an anchor; one store per anchor, shared', () => {
    const { anchor } = bootPair();
    expect(localUiSessionStore({ LOCAL_TRUST: 'true' })).toBeNull();
    expect(localUiSessionStore({ LOCAL_UI_BOOT_ANCHOR: anchor })).toBeNull();
    const store = localUiSessionStore({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: anchor });
    expect(store).toBeInstanceOf(LocalUiSessionStore);
    expect(localUiSessionStore({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: ` ${anchor} ` })).toBe(store);
    expect(localUiSessionStore({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: bootPair().anchor })).not.toBe(store);
  });

  it('throws on a malformed anchor under LOCAL_TRUST', () => {
    expect(() => localUiSessionStore({ LOCAL_TRUST: 'true', LOCAL_UI_BOOT_ANCHOR: 'not-hex' })).toThrow(/LOCAL_UI_BOOT_ANCHOR/);
  });

  it('reads the token from X-Local-Session only when it is a single string', () => {
    expect(localUiSessionToken({ headers: { 'x-local-session': 'abc' } })).toBe('abc');
    expect(localUiSessionToken({ headers: { 'x-local-session': ['a', 'b'] } })).toBeUndefined();
    expect(localUiSessionToken({ headers: {} })).toBeUndefined();
  });
});

describe('AnonymousAuthProvider with the interface session', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetLocalUiSessionStoreForTests();
  });
  const local = (headers: Record<string, string> = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', ...headers } });

  it('a genuine local request without the session is not the administrator; with it, it is', () => {
    const { code, anchor } = bootPair();
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '127.0.0.1', NODE_PORT: '3000', LOCAL_UI_BOOT_ANCHOR: anchor });
    const provider = new AnonymousAuthProvider();
    expect(provider.resolveRequest(local())).toBeNull();
    const { token } = localUiSessionStore()!.exchange(code)!;
    expect(provider.resolveRequest(local({ 'x-local-session': token }))).toEqual({ id: 0, admin: true, kind: 'local-trust' });
    expect(provider.resolveRequest(local({ 'x-local-session': randomBytes(32).toString('base64url') }))).toBeNull();
  });

  it('the session never replaces the local checks: a foreign Origin or a remote socket stays anonymous', () => {
    const { code, anchor } = bootPair();
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '127.0.0.1', NODE_PORT: '3000', LOCAL_UI_BOOT_ANCHOR: anchor });
    const provider = new AnonymousAuthProvider();
    const { token } = localUiSessionStore()!.exchange(code)!;
    expect(provider.resolveRequest(local({ 'x-local-session': token, origin: 'http://localhost:8080' }))).toBeNull();
    expect(provider.resolveRequest({ socket: { remoteAddress: '203.0.113.9' }, headers: { host: 'localhost:3000', 'x-local-session': token } })).toBeNull();
  });

  it('refuses to start on a malformed anchor', () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '127.0.0.1', NODE_PORT: '3000', LOCAL_UI_BOOT_ANCHOR: 'nope' });
    expect(() => new AnonymousAuthProvider()).toThrow(/LOCAL_UI_BOOT_ANCHOR/);
  });

  it('without an anchor, local trust is unchanged (opt-in)', () => {
    Object.assign(process.env, { LOCAL_TRUST: 'true', HOST: '127.0.0.1', NODE_PORT: '3000' });
    delete process.env.LOCAL_UI_BOOT_ANCHOR;
    expect(new AnonymousAuthProvider().resolveRequest(local())).toEqual({ id: 0, admin: true, kind: 'local-trust' });
  });
});
