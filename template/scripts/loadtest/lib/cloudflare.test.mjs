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

import { RULE_TAG, allowException, checkAccess, buildSkipRule, createCloudflareClient, findZoneId, revokeException, verifyToken } from './cloudflare.mjs';

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

test('checkAccess reads token, zone, rules and permissions without writing', async () => {
  const { client, calls } = fakeApi({
    'GET /user/tokens/verify': { status: 'active', id: 'tok1' },
    'GET /zones?name=ex.com': [{ id: 'z1' }],
    'GET /zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint': { id: 'rs' },
    'GET /user/tokens/tok1': { policies: [{ permission_groups: [{ name: 'Zone WAF Write' }, { name: 'Zone Read' }] }] },
  });
  const access = await checkAccess(client, 'ex.com');
  assert.deepEqual({ status: access.tokenStatus, canRead: access.canReadRules, write: access.looksAbleToWrite, zone: access.looksAbleToReadZones }, { status: 'active', canRead: true, write: true, zone: true });
  assert.ok(calls.every((c) => c.key.startsWith('GET ')));
});

test('checkAccess flags a read-only token and tolerates a token that cannot describe itself', async () => {
  const readOnly = fakeApi({
    'GET /user/tokens/verify': { status: 'active', id: 't' },
    'GET /zones?name=ex.com': [{ id: 'z1' }],
    'GET /user/tokens/t': { policies: [{ permission_groups: [{ name: 'Zone Read' }] }] },
  });
  const a = await checkAccess(readOnly.client, 'ex.com');
  assert.equal(a.canReadRules, true, 'a missing entrypoint (404) is readable');
  assert.equal(a.looksAbleToWrite, false);
  const opaque = fakeApi({ 'GET /user/tokens/verify': { status: 'active', id: 't' }, 'GET /zones?name=ex.com': [{ id: 'z1' }] });
  assert.equal((await checkAccess(opaque.client, 'ex.com')).looksAbleToWrite, null);
});

test('verifyToken falls back to the account endpoint for an account-owned token', async () => {
  const account = fakeApi({ 'GET /accounts/acc1/tokens/verify': { status: 'active', id: 'tk' } });
  const out = await verifyToken(account.client, 'acc1');
  assert.deepEqual({ status: out.status, scope: out.scope }, { status: 'active', scope: 'account' });
  await assert.rejects(verifyToken(account.client), /not found/, 'without an account id the user-endpoint error is reported');
  const user = fakeApi({ 'GET /user/tokens/verify': { status: 'active', id: 'tk' } });
  assert.equal((await verifyToken(user.client, 'acc1')).scope, 'user');
});

test('checkAccess describes an account-owned token through its account endpoint', async () => {
  const { client } = fakeApi({
    'GET /accounts/acc1/tokens/verify': { status: 'active', id: 'tk' },
    'GET /zones?name=ex.com': [{ id: 'z1' }],
    'GET /accounts/acc1/tokens/tk': { policies: [{ permission_groups: [{ name: 'Firewall Services Write' }] }] },
  });
  const access = await checkAccess(client, 'ex.com', 'acc1');
  assert.equal(access.tokenScope, 'account');
  assert.equal(access.looksAbleToWrite, true);
});

test('checkAccess keeps the diagnosis when the zone is not visible (no throw)', async () => {
  const { client } = fakeApi({
    'GET /accounts/acc1/tokens/verify': { status: 'active', id: 'tk' },
    'GET /zones?name=ex.com': [],
    'GET /accounts/acc1/tokens/tk': { policies: [{ permission_groups: [{ name: 'Workers Scripts Write' }, { name: 'Pages Write' }] }] },
  });
  const access = await checkAccess(client, 'ex.com', 'acc1');
  assert.equal(access.zoneId, null);
  assert.match(access.zoneError, /not found/);
  assert.deepEqual({ read: access.looksAbleToReadZones, write: access.looksAbleToWrite, rules: access.canReadRules }, { read: false, write: false, rules: null });
  assert.deepEqual(access.permissions, ['Workers Scripts Write', 'Pages Write']);
});
