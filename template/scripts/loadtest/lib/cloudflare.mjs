/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Temporary Cloudflare WAF exception for the load generator: a custom rule that skips rate limiting and the
 * security products for requests carrying a secret header, removed when the test is over. Without it the test
 * measures Cloudflare's protection instead of the origin.
 *
 * The rule payload is built by `buildSkipRule` and can be printed (`cloudflare plan`) to be applied by hand when
 * the API token lacks the permission (Zone → Zone WAF → Edit). Bot Fight Mode of the Free plan cannot be skipped
 * by any rule.
 */

const API = 'https://api.cloudflare.com/client/v4';
export const RULE_TAG = 'vx-loadtest (temporary, remove after the test)';
const PHASE = 'http_request_firewall_custom';
const SKIPPED_PRODUCTS = ['waf', 'rateLimit', 'bic', 'hot', 'securityLevel', 'uaBlock', 'zoneLockdown'];

export function buildSkipRule(headerName, secret) {
  return {
    action: 'skip',
    description: RULE_TAG,
    enabled: true,
    expression: `(any(http.request.headers["${headerName.toLowerCase()}"][*] eq "${secret}"))`,
    action_parameters: { products: SKIPPED_PRODUCTS },
  };
}

export function createCloudflareClient({ token, fetchImpl = fetch }) {
  async function call(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.success === false) {
      const message = json.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
      const error = new Error(`Cloudflare ${method} ${path}: ${message}`);
      error.status = response.status;
      throw error;
    }
    return json.result;
  }
  return { call };
}

export const verifyToken = (client) => client.call('GET', '/user/tokens/verify');

export async function findZoneId(client, zoneName) {
  const zones = await client.call('GET', `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zones?.length) throw new Error(`Cloudflare zone "${zoneName}" not found for this token`);
  return zones[0].id;
}

async function getEntrypoint(client, zoneId) {
  try {
    return await client.call('GET', `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/** Adds the skip rule (first position). Returns what `revokeException` needs. */
export async function allowException(client, { zone, headerName, secret }) {
  const zoneId = await findZoneId(client, zone);
  const rule = buildSkipRule(headerName, secret);
  const entrypoint = await getEntrypoint(client, zoneId);
  if (!entrypoint) {
    const created = await client.call('PUT', `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`, { rules: [rule] });
    return { zoneId, rulesetId: created.id, ruleId: created.rules[0].id };
  }
  const updated = await client.call('POST', `/zones/${zoneId}/rulesets/${entrypoint.id}/rules`, { ...rule, position: { index: 1 } });
  const added = updated.rules.find((r) => r.description === RULE_TAG);
  return { zoneId, rulesetId: entrypoint.id, ruleId: added?.id };
}

export async function revokeException(client, { zoneId, rulesetId, ruleId }) {
  if (!ruleId) throw new Error('No rule id recorded: remove the rule tagged "vx-loadtest" from the Cloudflare dashboard');
  await client.call('DELETE', `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`);
}
