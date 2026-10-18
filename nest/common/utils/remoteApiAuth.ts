/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';

const logger = new Logger('RemoteApiAuth');
let legacyWarned = false;

/**
 * Credential headers for server-side calls to the remote data API of the `-remote` modules (ChainTradingDataAPI).
 * - `REMOTE_API_KEY` (preferred): a scoped `api-access` key of the remote API, sent as `X-API-Key`;
 * - otherwise the legacy `TECH_TOKEN` JWT as `Authorization: Bearer` (one warning per process): kept only so the
 *   deploy order is free during the cutover. It stops working once the remote API rotates its JWT secret;
 * - neither: no header (the remote call will be refused).
 * Server-side only: never expose either value to a browser bundle.
 */
export function remoteApiAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.REMOTE_API_KEY?.trim();
  if (key) return { 'X-API-Key': key };
  const token = env.TECH_TOKEN?.trim();
  if (!token) return {};
  if (!legacyWarned) {
    legacyWarned = true;
    logger.warn('REMOTE_API_KEY is not set: remote API calls fall back to the legacy TECH_TOKEN bearer. Set REMOTE_API_KEY (scoped api-access key) before the remote API rotates its JWT secret.');
  }
  return { Authorization: `Bearer ${token}` };
}
