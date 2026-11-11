/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { Public } from '../decorators/Public';
import { SecurityException } from '../exceptions/SecurityException';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import { isLocalTrustRequest, type LocalTrustRequest } from './localTrust';
import { localUiSessionStore, localUiSessionToken, type IssuedLocalUiSession, type LocalUiSessionStore } from './localUiSession';

/**
 * The interface session of a local-trust app (`localUiSession.ts`, README « Session d'interface locale »): the page exchanges the boot code of
 * its URL fragment, then renews its token. Both routes are `@Public` (they come before any principal) but answer only a genuine local request
 * (`isLocalTrustRequest`: loopback socket, local Host, the app's own origin) and only when the session is required; anything else is the same
 * `401`. Never logs a code nor a token.
 */
@Controller()
export class LocalUiSessionController {
  private readonly logger = new Logger(LocalUiSessionController.name);
  private readonly store: LocalUiSessionStore | null;

  constructor(@Inject(AUTH_PORT) port: AuthPort) {
    // Only the anonymous provider grants local trust (the `user` module's provider never does): no session to hand out otherwise.
    this.store = port.mode === 'anonymous' ? localUiSessionStore() : null;
  }

  /** Whether this app requires the interface session, and whether the request carries a live one (no secret in the answer). */
  @Public()
  @Get('/api/v1/local-ui/session')
  status(@Req() req: LocalTrustRequest): { required: boolean; active: boolean } {
    if (!this.store) return { required: false, active: false };
    return { required: true, active: isLocalTrustRequest(req) && this.store.verify(localUiSessionToken(req)) };
  }

  /** The boot code (body `{ code }`, once per launch) for a first session token. */
  @Public()
  @Post('/api/v1/local-ui/session')
  @HttpCode(200)
  exchange(@Req() req: LocalTrustRequest, @Body() body: Record<string, unknown> | undefined): IssuedLocalUiSession {
    const store = this.localStore(req);
    const issued = store.exchange(body?.code);
    if (!issued) {
      this.logger.warn(`interface boot code refused (${store.bootPending ? 'wrong code' : 'already exchanged'})`);
      throw new SecurityException('AUT', 'Unauthorized');
    }
    return issued;
  }

  /** A new token for the live one the request carries (`X-Local-Session`); the old one passes a short grace, then never again. */
  @Public()
  @Post('/api/v1/local-ui/session/renew')
  @HttpCode(200)
  renew(@Req() req: LocalTrustRequest): IssuedLocalUiSession {
    const issued = this.localStore(req).renew(localUiSessionToken(req));
    if (!issued) throw new SecurityException('AUT', 'Unauthorized');
    return issued;
  }

  private localStore(req: LocalTrustRequest): LocalUiSessionStore {
    if (!this.store || !isLocalTrustRequest(req)) throw new SecurityException('AUT', 'Unauthorized');
    return this.store;
  }
}
