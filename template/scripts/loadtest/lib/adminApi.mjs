/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Admin API client of the `user` module: creates the synthetic accounts of a load test, issues their static API
 * tokens, and revokes/removes them afterwards. The admin token is only ever sent as a Bearer header and never
 * appears in an error message or a log line.
 */

import { sleep } from './util.mjs';

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

export function createAdminClient({ baseUrl, token, fetchImpl = fetch, backoffMs = 1000 }) {
  const root = baseUrl.replace(/\/$/, '');
  async function request(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  }
  return { request };
}

const fill = (template, id) => template.replace('{id}', String(id));
export const nicknameOf = (prefix, index) => `${prefix}-${String(index).padStart(3, '0')}`;

/**
 * Creates the missing accounts (1..count) and returns the full list. `onUser` is called after each account
 * so the caller can persist progress: a crash never leaves an account unknown to the teardown.
 */
export async function createUsers(client, auth, existing, onUser = () => {}) {
  const users = [...existing];
  const have = new Set(users.map((u) => u.nickname));
  for (let index = 1; index <= auth.userCount; index++) {
    const nickname = nicknameOf(auth.prefix, index);
    if (have.has(nickname)) continue;
    const created = await client.request('POST', auth.paths.create, { nickname, ...(auth.tierId ? { tierId: auth.tierId } : {}) });
    if (!created?.id) throw new Error(`POST ${auth.paths.create} returned no id`);
    const entry = { id: created.id, nickname, token: null, jti: null };
    users.push(entry);
    onUser(entry, users);
    const issued = await client.request('POST', fill(auth.paths.token, entry.id));
    Object.assign(entry, { token: issued.token, jti: issued.jti });
    onUser(entry, users);
  }
  return users;
}

/** Issues a token to accounts that were created but whose token step failed (resume after a crash). */
export async function issueMissingTokens(client, auth, users, onUser = () => {}) {
  for (const entry of users.filter((u) => !u.token)) {
    const issued = await client.request('POST', fill(auth.paths.token, entry.id));
    Object.assign(entry, { token: issued.token, jti: issued.jti });
    onUser(entry, users);
  }
}

/** Revokes every token, then removes the accounts through the admin API (soft delete + anonymization). */
export async function revokeAndRemove(client, auth, users, onProgress = () => {}) {
  const result = { revoked: 0, removed: 0, failed: [] };
  for (const user of users) {
    try {
      if (user.jti) { await client.request('POST', auth.paths.revoke, { jti: user.jti }); result.revoked++; }
      await client.request('DELETE', fill(auth.paths.remove, user.id));
      result.removed++;
    } catch (error) {
      result.failed.push({ id: user.id, error: error.message });
    }
    onProgress(user, result);
  }
  return result;
}
