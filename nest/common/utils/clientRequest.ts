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
 * Real client IP behind a reverse proxy that sets X-Forwarded-For
 * ($proxy_add_x_forwarded_for). Takes the first hop (original client) and
 * falls back to the raw socket address for direct/local connections.
 */
export function extractClientIp(req: Request): string | null {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (forwardedValue) {
    const firstHop = forwardedValue.split(',')[0]?.trim();
    if (firstHop) return firstHop;
  }
  return req.socket?.remoteAddress ?? null;
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
