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

import { RULE_TAG, allowException, buildSkipRule, createCloudflareClient, findZoneId, revokeException, verifyToken } from './cloudflare.mjs';

function fakeApi(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url.replace('https://api.cloudflare.com/client/v4', '')}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ message: 'not found' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, result: handler }) };
  };
  return { calls, client: createCloudflareClient({ token: 't', fetchImpl }) };
}

test('buildSkipRule matches the secret header and skips rate limiting', () => {
  const rule = buildSkipRule('X-LoadTest-Key', 'abc');
  assert.equal(rule.action, 'skip');
  assert.equal(rule.description, RULE_TAG);
  assert.ok(rule.expression.includes('["x-loadtest-key"]') && rule.expression.includes('"abc"'));
  assert.ok(rule.action_parameters.products.includes('rateLimit'));
});

test('verifyToken and findZoneId', async () => {
  const { client } = fakeApi({ 'GET /user/tokens/verify': { status: 'active' }, 'GET /zones?name=ex.com': [{ id: 'z1' }], 'GET /zones?name=none.com': [] });
  assert.equal((await verifyToken(client)).status, 'active');
  assert.equal(await findZoneId(client, 'ex.com'), 'z1');
  await assert.rejects(findZoneId(client, 'none.com'), /not found/);
});

test('allowException creates the entrypoint ruleset when there is none', async () => {
  const { client, calls } = fakeApi({
    'GET /zones?name=ex.com': [{ id: 'z1' }],
    'PUT /zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint': { id: 'rs1', rules: [{ id: 'r1' }] },
  });
  const state = await allowException(client, { zone: 'ex.com', headerName: 'x-k', secret: 's' });
  assert.deepEqual(state, { zoneId: 'z1', rulesetId: 'rs1', ruleId: 'r1' });
  assert.equal(calls.at(-1).body.rules.length, 1);
});

test('allowException adds the rule first in an existing ruleset', async () => {
  const { client, calls } = fakeApi({
    'GET /zones?name=ex.com': [{ id: 'z1' }],
    'GET /zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint': { id: 'rs9' },
    'POST /zones/z1/rulesets/rs9/rules': { rules: [{ id: 'old', description: 'x' }, { id: 'new', description: RULE_TAG }] },
  });
  const state = await allowException(client, { zone: 'ex.com', headerName: 'x-k', secret: 's' });
  assert.equal(state.ruleId, 'new');
  assert.deepEqual(calls.at(-1).body.position, { index: 1 });
});

test('revokeException deletes the recorded rule and refuses without an id', async () => {
  const { client, calls } = fakeApi({ 'DELETE /zones/z1/rulesets/rs1/rules/r1': {} });
  await revokeException(client, { zoneId: 'z1', rulesetId: 'rs1', ruleId: 'r1' });
  assert.equal(calls[0].key, 'DELETE /zones/z1/rulesets/rs1/rules/r1');
  await assert.rejects(revokeException(client, { zoneId: 'z1', rulesetId: 'rs1' }), /remove the rule/);
});
