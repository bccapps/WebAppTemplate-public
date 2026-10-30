/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdminClient, createUsers, issueMissingTokens, nicknameOf, revokeAndRemove } from './adminApi.mjs';

const auth = { userCount: 3, prefix: 'lt', tierId: 7, paths: { create: '/c', token: '/u/{id}/t', revoke: '/r', remove: '/u/{id}' } };

function fakeServer() {
  const calls = [];
  let next = 100;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push({ method: init.method, pathname, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const json = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    if (pathname === '/c') return json({ id: next++ });
    if (pathname.endsWith('/t')) return json({ token: `tok-${pathname}`, jti: `jti-${pathname}` });
    return { ok: true, status: 204, text: async () => '' };
  };
  return { calls, client: createAdminClient({ baseUrl: 'https://api.example.com/', token: 'ADMIN', fetchImpl, backoffMs: 0 }) };
}

test('nicknameOf pads the index', () => {
  assert.equal(nicknameOf('lt', 7), 'lt-007');
});

test('createUsers creates accounts then issues tokens, sending the tier', async () => {
  const { client, calls } = fakeServer();
  const saved = [];
  const users = await createUsers(client, auth, [], (entry) => saved.push(entry.nickname));
  assert.equal(users.length, 3);
  assert.deepEqual(users.map((u) => u.nickname), ['lt-001', 'lt-002', 'lt-003']);
  assert.ok(users.every((u) => u.token && u.jti));
  assert.deepEqual(calls[0].body, { nickname: 'lt-001', tierId: 7 });
  assert.equal(calls[0].auth, 'Bearer ADMIN');
  assert.ok(saved.length >= 6);
});

test('createUsers resumes: existing accounts are not recreated', async () => {
  const { client, calls } = fakeServer();
  const existing = [{ id: 1, nickname: 'lt-001', token: 't', jti: 'j' }];
  const users = await createUsers(client, auth, existing);
  assert.equal(users.length, 3);
  assert.equal(calls.filter((c) => c.pathname === '/c').length, 2);
});

test('issueMissingTokens only touches accounts without a token', async () => {
  const { client, calls } = fakeServer();
  const users = [{ id: 1, nickname: 'a', token: 'x', jti: 'y' }, { id: 2, nickname: 'b', token: null, jti: null }];
  await issueMissingTokens(client, auth, users);
  assert.equal(calls.length, 1);
  assert.equal(users[1].token, 'tok-/u/2/t');
});

test('revokeAndRemove revokes each jti then deletes, collecting failures', async () => {
  const { client, calls } = fakeServer();
  const users = [{ id: 1, jti: 'j1' }, { id: 2, jti: null }];
  const result = await revokeAndRemove(client, auth, users);
  assert.deepEqual({ revoked: result.revoked, removed: result.removed, failed: result.failed.length }, { revoked: 1, removed: 2, failed: 0 });
  assert.deepEqual(calls[0].body, { jti: 'j1' });
  const broken = createAdminClient({ baseUrl: 'https://x', token: 't', backoffMs: 0, fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  const failed = await revokeAndRemove(broken, auth, [{ id: 9, jti: null }]);
  assert.equal(failed.failed.length, 1);
});

test('the client retries 429/5xx then fails without leaking the token', async () => {
  let attempts = 0;
  const flaky = createAdminClient({ baseUrl: 'https://x', token: 'SECRET', backoffMs: 0, fetchImpl: async () => { attempts++; return attempts < 3 ? { ok: false, status: 429 } : { ok: true, status: 200, text: async () => '{"ok":true}' }; } });
  assert.deepEqual(await flaky.request('GET', '/p'), { ok: true });
  assert.equal(attempts, 3);
  const dead = createAdminClient({ baseUrl: 'https://x', token: 'SECRET', backoffMs: 0, fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(dead.request('GET', '/p'), (error) => !error.message.includes('SECRET') && /HTTP 500/.test(error.message));
});
