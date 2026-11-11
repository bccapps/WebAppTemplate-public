/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, HttpStatus, Get, HttpCode, Inject, Logger, NotFoundException, type OnApplicationBootstrap, Post, Query, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../decorators/Public';
import { AppException } from '../exceptions/AppException';
import { SecurityException } from '../exceptions/SecurityException';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import { isLocalTrustRequest, isLoopbackAddress, type LocalTrustRequest } from './localTrust';
import { localUiSessionStore, localUiSessionToken, localUiShellKey, shellProof, type IssuedLocalUiSession, type LocalUiSessionStore } from './localUiSession';

const NONCE_RE = /^[0-9a-f]{64}$/;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];
/** Refused boot codes are logged as one line per window, with their count (an agent flooding the route never floods the log). */
const REFUSAL_LOG_WINDOW_MS = 60_000;

/**
 * The interface session of a local-trust app (`localUiSession.ts`, README « Session d'interface locale »): the launcher's challenge, the
 * exchange of the boot code, the renewal. All `@Public` (they come before any principal) and outside the global rate limiter
 * (`@SkipThrottle`): every local process shares the loopback address, so an agent flooding them must not use up the window's budget; the
 * work per request is one SHA-256. The exchange and the renewal answer only a genuine local request (`isLocalTrustRequest`). Never logs a
 * code, a nonce, a proof nor a token.
 */
@Controller()
@SkipThrottle()
export class LocalUiSessionController implements OnApplicationBootstrap {
  private readonly logger = new Logger(LocalUiSessionController.name);
  private readonly store: LocalUiSessionStore | null;
  private readonly shellKey: string | null;
  private refusals = 0;
  private refusalWindowStart = 0;

  constructor(@Inject(AUTH_PORT) port: AuthPort) {
    // Only the anonymous provider grants local trust (the `user` module's provider never does): no session to hand out otherwise.
    const anonymous = port.mode === 'anonymous';
    this.store = anonymous ? localUiSessionStore() : null;
    this.shellKey = anonymous ? localUiShellKey() : null;
  }

  /** The boot code must be exchanged soon after the app is ready (the launcher opens the window right after its health check). */
  onApplicationBootstrap(): void {
    this.store?.armBootWindow();
  }

  /**
   * The launcher's challenge: proves this process holds `LOCAL_UI_SHELL_KEY`, so the window and the boot code go to the back the launcher
   * started, never to another process that took or shares its port. Loopback socket, no proxy header. `404` without a key.
   */
  @Public()
  @Get('/api/v1/local-ui/shell-proof')
  shellProof(@Req() req: LocalTrustRequest, @Query('nonce') nonce: unknown): { proof: string } {
    if (!this.shellKey) throw new NotFoundException();
    const headers = req.headers ?? {};
    if (!isLoopbackAddress(req.socket?.remoteAddress) || PROXY_HEADERS.some((h) => headers[h] !== undefined) || typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new SecurityException('AUT', 'Unauthorized');
    }
    return { proof: shellProof(this.shellKey, nonce) };
  }

  /** Whether this app requires the interface session, and whether the request carries a live one (no secret in the answer). */
  @Public()
  @Get('/api/v1/local-ui/session')
  status(@Req() req: LocalTrustRequest): { required: boolean; active: boolean } {
    if (!this.store) return { required: false, active: false };
    return { required: true, active: isLocalTrustRequest(req) && this.store.verify(localUiSessionToken(req)) };
  }

  /** The boot code (body `{ code }`, once per launch, within the boot window) for a first session token. */
  @Public()
  @Post('/api/v1/local-ui/session')
  @HttpCode(200)
  exchange(@Req() req: LocalTrustRequest, @Body() body: Record<string, unknown> | undefined): IssuedLocalUiSession {
    const store = this.localStore(req);
    const issued = store.exchange(body?.code);
    if (!issued) {
      this.noteRefusal();
      throw new SecurityException('AUT', 'Unauthorized');
    }
    return issued;
  }

  /**
   * A new token for the live one the request carries (`X-Local-Session`); the old one passes a short grace, then never again. A token
   * renewed already answers `409 LOCAL_UI_SESSION_RENEWED` (someone else holds the chain: the page reopens).
   */
  @Public()
  @Post('/api/v1/local-ui/session/renew')
  @HttpCode(200)
  renew(@Req() req: LocalTrustRequest): IssuedLocalUiSession {
    const renewal = this.localStore(req).renew(localUiSessionToken(req));
    if (renewal === 'renewed') throw new AppException('LOCAL_UI_SESSION_RENEWED', 'This session token was already renewed', HttpStatus.CONFLICT);
    if (!renewal) throw new SecurityException('AUT', 'Unauthorized');
    return renewal;
  }

  private localStore(req: LocalTrustRequest): LocalUiSessionStore {
    if (!this.store || !isLocalTrustRequest(req)) throw new SecurityException('AUT', 'Unauthorized');
    return this.store;
  }

  /** One warning per window at most, with the count (no value is ever logged). */
  private noteRefusal(): void {
    const now = Date.now();
    if (now - this.refusalWindowStart >= REFUSAL_LOG_WINDOW_MS) {
      if (this.refusals > 0) this.logger.warn(`interface boot code refused ${this.refusals} more time(s) in the last minute`);
      this.refusalWindowStart = now;
      this.refusals = 0;
      this.logger.warn(`interface boot code refused (${this.store?.bootPending ? 'wrong code' : 'already exchanged or expired'})`);
      return;
    }
    this.refusals += 1;
  }
}
