/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { AuthPort } from './AuthPort';
import type { AuthPrincipal } from './AuthPrincipal';
import { assertLocalTrustHost, isLocalTrustEnabled, isLocalTrustRequest, type LocalTrustRequest } from './localTrust';
import { localUiSessionStore, localUiSessionToken, type LocalUiSessionStore } from './localUiSession';
import { resolveListenHost } from '../bootstrap/configureHttpApp';

const MIN_ADMIN_TOKEN_LENGTH = 32;

/**
 * Auth provider used when no user module is linked: the only identity is the
 * admin, authenticated by the ADMIN_TOKEN environment variable.
 */
@Injectable()
export class AnonymousAuthProvider implements AuthPort {
  readonly mode = 'anonymous' as const;
  private readonly logger = new Logger(AnonymousAuthProvider.name);
  private readonly expected: Buffer | null;
  private readonly localTrust: boolean;
  /** Interface session (`localUiSession.ts`): required on top of the local checks when the app was started with `LOCAL_UI_BOOT_ANCHOR`. */
  private readonly uiSessions: LocalUiSessionStore | null;

  constructor() {
    this.localTrust = isLocalTrustEnabled();
    this.uiSessions = null;
    if (this.localTrust) {
      // Refuses to start (the rejection stops bootstrap) when the server is reachable from the network, or when the boot anchor is malformed.
      assertLocalTrustHost(resolveListenHost());
      this.uiSessions = localUiSessionStore();
      this.logger.warn(
        this.uiSessions
          ? 'LOCAL_TRUST=true: loopback requests with a local Host/Origin AND the interface session are administrators'
          : 'LOCAL_TRUST=true: loopback requests with a local Host/Origin are administrators (no key needed)',
      );
    }
    const token = process.env.ADMIN_TOKEN ?? '';
    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
      this.expected = null;
      this.logger.warn(
        `ADMIN_TOKEN is missing or shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters: admin access is disabled`,
      );
    } else {
      this.expected = Buffer.from(token, 'utf8');
    }
  }

  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    if (!this.expected || !token) return null;
    const given = Buffer.from(token, 'utf8');
    if (given.length !== this.expected.length) return null;
    if (!timingSafeEqual(given, this.expected)) return null;
    return { id: 0, admin: true, kind: 'admin-token' };
  }

  /**
   * Local trust: administrator for a genuine local request that also carries the interface session when one is required (every route,
   * reads included: there is no list of routes to keep up to date), `null` (normal anonymous behaviour) otherwise.
   */
  resolveRequest(req: LocalTrustRequest): AuthPrincipal | null {
    if (!this.localTrust || !isLocalTrustRequest(req)) return null;
    if (this.uiSessions && !this.uiSessions.verify(localUiSessionToken(req))) return null;
    return { id: 0, admin: true, kind: 'local-trust' };
  }
}
