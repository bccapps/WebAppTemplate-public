/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** `RequireHumanSessionInterceptor` fails CLOSED (second review, finding 6): only a marked human session passes. */
import { describe, expect, it } from '@jest/globals';
import { isHumanSessionRequest } from './interactionRequest';

type Req = Parameters<typeof isHumanSessionRequest>[0];
const req = (user: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Req => ({ user, ...extra }) as unknown as Req;
const session = { id: 7, admin: false, kind: 'user', isHumanSession: true };

describe('isHumanSessionRequest', () => {
  it('admits a user principal marked as a human session (an administrator’s session too)', () => {
    expect(isHumanSessionRequest(req(session))).toBe(true);
    expect(isHumanSessionRequest(req({ ...session, admin: true }))).toBe(true);
  });

  it('refuses a principal WITHOUT the positive marker, or with a falsy / non-boolean one (fail closed)', () => {
    for (const marker of [undefined, false, 'true', 1, null]) expect(isHumanSessionRequest(req({ id: 7, admin: false, kind: 'user', isHumanSession: marker }))).toBe(false);
  });

  it('refuses an API token even if it also claims to be a session, and every non-user or malformed principal', () => {
    expect(isHumanSessionRequest(req({ ...session, isApiToken: true }))).toBe(false);
    for (const user of [undefined, { ...session, kind: 'admin-token' }, { ...session, kind: 'local-trust' }, { ...session, id: 0 }, { ...session, id: -1 }, { ...session, id: 1.5 }, { ...session, id: '7' }]) {
      expect(isHumanSessionRequest(req(user as Record<string, unknown> | undefined))).toBe(false);
    }
  });

  it('refuses a session request that also carries a service or MCP credential', () => {
    for (const extra of [{ servicePrincipal: {} }, { mcpPrincipal: {} }, { mcpCredential: {} }]) expect(isHumanSessionRequest(req(session, extra))).toBe(false);
  });
});
