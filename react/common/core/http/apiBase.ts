/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** The app's own API base (`VITE_API_URL`, else `/api/v1`): what `configurationService.getApiUrl()` answers for a local module. Leaf module (no import). */
export const DEFAULT_API_URL: string = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || '/api/v1';
