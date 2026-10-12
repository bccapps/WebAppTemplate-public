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
 *
 * Bearer tokens are optional per API — sourced from VITE_* env vars.
 * If not set, no Authorization header is added for that API.
 * Tokens are automatically registered with HttpService so that requests
 * to remote APIs use the correct bearer token instead of the user JWT.
 */

import { httpService } from '@/modules_shared/common/core/http/HttpService';

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || '/api/v1';

const apiUrlMap: Record<string, string> = {
  default: DEFAULT_API_URL,
};

// Register API-specific tokens with HttpService
const techToken = import.meta.env.VITE_TECH_TOKEN;
if (techToken) {
  for (const [apiName, url] of Object.entries(apiUrlMap)) {
    if (apiName !== 'default' && url !== DEFAULT_API_URL) {
      httpService.registerApiToken(url, techToken);
    }
  }
}

export const getApiBaseUrl = (apiName?: string): string => {
  const key = apiName ?? 'default';
  return apiUrlMap[key] ?? apiUrlMap.default;
};
