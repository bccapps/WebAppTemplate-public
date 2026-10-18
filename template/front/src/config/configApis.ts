/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Central mapping for every API base URL used by the frontend.
 * Add one entry per remote module listed in shared-modules.json once it needs
 * to be redirected to a different backend. Fallback when a key is missing is
 * DEFAULT_API_URL.
 */

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || '/api/v1';

const apiUrlMap: Record<string, string> = {
  default: DEFAULT_API_URL,
};

// No credential here: every VITE_* value is inlined into the PUBLIC bundle. A remote API that
// needs a server-to-server token (TECH_TOKEN) is called through this app's back, never from
// the browser.

export const getApiBaseUrl = (apiName?: string): string => {
  const key = apiName ?? 'default';
  return apiUrlMap[key] ?? apiUrlMap.default;
};
