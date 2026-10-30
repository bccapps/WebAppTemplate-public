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

import { fetchPublicTiers, pickTier, tierList } from './tiers.mjs';

const tiers = [
  { id: 5, name: 'pro', tierLevel: 4 },
  { id: 1, name: 'freemium', tierLevel: 1 },
  { id: 2, name: 'standard', tierLevel: 2 },
];

test('tierList accepts a bare array or an envelope', () => {
  assert.equal(tierList([1]).length, 1);
  assert.equal(tierList({ data: [1, 2] }).length, 2);
  assert.deepEqual(tierList({}), []);
});

test('pickTier: highest, lowest, id and name', () => {
  assert.equal(pickTier(tiers).name, 'pro');
  assert.equal(pickTier(tiers, 'lowest').name, 'freemium');
  assert.equal(pickTier(tiers, 2).name, 'standard');
  assert.equal(pickTier(tiers, '5').name, 'pro');
  assert.equal(pickTier(tiers, 'STANDARD').id, 2);
});

test('pickTier lists the available tiers when nothing matches or none exists', () => {
  assert.throws(() => pickTier(tiers, 'gold'), /not found among public tiers: freemium \(id 1, level 1\), standard/);
  assert.throws(() => pickTier([]), /no public tier/);
});

test('fetchPublicTiers calls /tiers/public without credentials', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers }; return { ok: true, json: async () => tiers }; };
  assert.equal((await fetchPublicTiers('https://a.io/api/v1/', fetchImpl)).length, 3);
  assert.equal(seen.url, 'https://a.io/api/v1/tiers/public');
  assert.equal(seen.headers.Authorization, undefined);
  await assert.rejects(fetchPublicTiers('https://a.io', async () => ({ ok: false, status: 500 })), /HTTP 500/);
});
