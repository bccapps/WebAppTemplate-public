/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The push services a Web Push endpoint may point at (review F8). A browser's `PushSubscription.endpoint` is a URL of
// its vendor's push service; a user could post any `https` URL instead (a blind POST relay, a probe). Pure.

/**
 * The push services of the major browsers: Chrome / Edge-Chromium / Opera / Samsung (Firebase Cloud Messaging), Firefox
 * (Mozilla autopush, `updates.push.services.mozilla.com`), legacy Edge / Windows (WNS, `<region>.notify.windows.com`),
 * Safari (`web.push.apple.com`, Apple asks to allow `*.push.apple.com`). `*.` = any subdomain (not the domain itself).
 */
export const DEFAULT_PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', '*.push.services.mozilla.com', '*.notify.windows.com', '*.push.apple.com'];

const PATTERN = /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The default list plus the app's extra hosts (`forRoot({ pushHostAllowlist })`), lower-cased; throws on a malformed one. */
export function pushHostPatterns(extra: readonly string[] | undefined): string[] {
  const out = new Set<string>(DEFAULT_PUSH_HOSTS);
  for (const raw of extra ?? []) {
    const pattern = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!PATTERN.test(pattern)) throw new Error(`[interaction] invalid push host "${String(raw)}" in pushHostAllowlist (a host name, or *.domain)`);
    out.add(pattern);
  }
  return [...out];
}

/** An `https` URL on the default port whose host is one of `patterns` (exact, or a subdomain of a `*.` pattern). */
export function isAllowedPushEndpoint(endpoint: string | URL, patterns: readonly string[]): boolean {
  let url: URL;
  try {
    url = typeof endpoint === 'string' ? new URL(endpoint) : endpoint;
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern));
}
