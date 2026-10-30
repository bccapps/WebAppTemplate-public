/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Picks the access tier of the synthetic accounts from the public tier list (`GET /tiers/public`: enabled tiers only,
 * so never an admin or draft tier). `highest` is the default: the account that unlocks the most features is the
 * heaviest realistic user.
 */

/** The public endpoint answers a bare array (or an envelope with `data`). */
export const tierList = (body) => (Array.isArray(body) ? body : (body?.data ?? []));

/**
 * `selector`: `highest` | `lowest` | a tier id (number or numeric string) | a tier name (case-insensitive).
 * Throws with the available tiers when nothing matches.
 */
export function pickTier(tiers, selector = 'highest') {
  const list = [...tiers].sort((a, b) => (a.tierLevel ?? 0) - (b.tierLevel ?? 0));
  const available = list.map((t) => `${t.name} (id ${t.id}, level ${t.tierLevel})`).join(', ') || 'none';
  if (!list.length) throw new Error('no public tier available');
  if (selector === 'highest') return list.at(-1);
  if (selector === 'lowest') return list[0];
  const found = list.find((t) => String(t.id) === String(selector) || String(t.name).toLowerCase() === String(selector).toLowerCase());
  if (!found) throw new Error(`tier "${selector}" not found among public tiers: ${available}`);
  return found;
}

export async function fetchPublicTiers(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/tiers/public`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GET /tiers/public → HTTP ${response.status}`);
  return tierList(await response.json());
}
