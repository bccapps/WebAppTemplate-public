/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Request } from 'express';

/**
 * Client IP as Express resolves it (`req.ip`): the `X-Forwarded-For` chain is walked from the right through the proxies
 * that `TRUST_PROXY` trusts only, so a client cannot choose it. Never the first `X-Forwarded-For` entry (the client
 * writes it). Falls back to the socket address, then `null`.
 */
export function extractClientIp(req: Pick<Request, 'ip' | 'socket'>): string | null {
  return req.ip || req.socket?.remoteAddress || null;
}

/** Provenance headers captured alongside a public sign-up, for auditing and anti-abuse. */
export interface ClientRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  referrer: string | null;
  acceptLanguage: string | null;
}

export function extractClientMeta(req: Request): ClientRequestMeta {
  return {
    ipAddress: extractClientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
    referrer: req.headers['referer'] ?? null,
    acceptLanguage: req.headers['accept-language'] ?? null,
  };
}
