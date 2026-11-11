/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Where a notice's link may lead: a path of the app only (never another origin). Navigation itself is injected, so
// the host can use the app router (no page reload) and the rule stays testable without a DOM.

/** Goes to an app path (router navigation, or a full page load as the fallback outside a router). */
export type Navigate = (path: string) => void;

/** The path when `url` is a relative path of the app (`/x`, never `//host` nor `/\host`), otherwise null. */
export function appPathOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  if (url.startsWith('//') || url.startsWith('/\\')) return null;
  if ([...url].some((char) => char.charCodeAt(0) < 32)) return null;
  return url;
}

/** Opens a notice's link through `navigate`; false (and nothing done) when it is not an app path. */
export function openAppPath(url: string | null | undefined, navigate: Navigate): boolean {
  const path = appPathOf(url);
  if (!path) return false;
  navigate(path);
  return true;
}
