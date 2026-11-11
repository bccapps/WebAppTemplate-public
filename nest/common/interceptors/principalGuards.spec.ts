/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { RejectApiTokenInterceptor } from './RejectApiTokenInterceptor';
import { isHumanSessionRequest, RequireHumanSessionInterceptor } from './RequireHumanSessionInterceptor';

const ctx = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
const handler = (): CallHandler => ({ handle: jest.fn().mockReturnValue('next') }) as unknown as CallHandler;

const API_TOKEN = { id: 7, admin: false, kind: 'user', isApiToken: true };
const HUMAN = { id: 7, admin: false, kind: 'user', isHumanSession: true };
const ADMIN_HUMAN = { id: 1, admin: true, kind: 'user', isHumanSession: true };
const ADMIN_API_TOKEN = { id: 1, admin: true, kind: 'user', isApiToken: true };
const LOCAL_TRUST = { id: 0, admin: true, kind: 'local-trust' };
const ADMIN_TOKEN = { id: 0, admin: true, kind: 'admin-token' };
const SERVICE = { kind: 'service', scope: 'tradingplatform:read' };
const LEGACY_USER = { id: 7, admin: false };

function refusal(fn: () => unknown): { status: number; body: unknown } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
  }
  throw new Error('expected a refusal');
}

describe('RejectApiTokenInterceptor (negative)', () => {
  const i = new RejectApiTokenInterceptor();

  it.each([
    ['API token', API_TOKEN],
    ['admin API token', ADMIN_API_TOKEN],
  ])('refuses a %s with the uniform coded 403', (_n, user) => {
    const h = handler();
    const r = refusal(() => i.intercept(ctx({ user }), h));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ statusCode: 403, code: 'API_TOKEN_NOT_ALLOWED' });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['human session', HUMAN],
    ['admin session', ADMIN_HUMAN],
    ['local-trust', LOCAL_TRUST],
    ['admin-token', ADMIN_TOKEN],
    ['legacy user without marker', LEGACY_USER],
    ['isApiToken as a string', { ...HUMAN, isApiToken: 'true' }],
    ['isApiToken false', { ...HUMAN, isApiToken: false }],
  ])('passes a %s', (_n, user) => {
    expect(i.intercept(ctx({ user }), handler())).toBe('next');
  });

  it('passes a service principal (no req.user) and a missing user: it does not authenticate', () => {
    expect(i.intercept(ctx({ servicePrincipal: SERVICE }), handler())).toBe('next');
    expect(i.intercept(ctx({}), handler())).toBe('next');
    expect(i.intercept(ctx({ user: null }), handler())).toBe('next');
  });
});

describe('RequireHumanSessionInterceptor (positive, fail closed)', () => {
  const i = new RequireHumanSessionInterceptor();

  it.each([
    ['human session', HUMAN],
    ['admin human session', ADMIN_HUMAN],
  ])('passes a %s', (_n, user) => {
    expect(i.intercept(ctx({ user }), handler())).toBe('next');
  });

  it.each([
    ['API token', API_TOKEN],
    ['admin API token', ADMIN_API_TOKEN],
    ['local-trust principal', LOCAL_TRUST],
    ['admin-token principal', ADMIN_TOKEN],
    ['service principal fields on user', { ...SERVICE, isHumanSession: true }],
    ['legacy user without marker', LEGACY_USER],
    ['isHumanSession as a string', { ...HUMAN, isHumanSession: 'true' }],
    ['isHumanSession truthy number', { ...HUMAN, isHumanSession: 1 }],
    ['both flags set', { ...HUMAN, isApiToken: true }],
    ['human flag without kind', { id: 7, isHumanSession: true }],
    ['human flag with kind local-trust', { ...LOCAL_TRUST, isHumanSession: true }],
  ])('refuses a %s with the uniform coded 403', (_n, user) => {
    const h = handler();
    const r = refusal(() => i.intercept(ctx({ user }), h));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ statusCode: 403, code: 'HUMAN_SESSION_REQUIRED' });
    expect(h.handle).not.toHaveBeenCalled();
  });

  it('refuses a human session carrying a machine credential besides, or without a positive id (aligned with the interaction module)', () => {
    for (const extra of [{ servicePrincipal: SERVICE }, { mcpPrincipal: { kind: 'mcp' } }, { mcpCredential: { id: 'c-1' } }]) {
      expect(refusal(() => i.intercept(ctx({ user: HUMAN, ...extra }), handler())).body).toMatchObject({ code: 'HUMAN_SESSION_REQUIRED' });
    }
    for (const id of [0, -1, 1.5, '7', undefined]) expect(refusal(() => i.intercept(ctx({ user: { ...HUMAN, id } }), handler())).status).toBe(403);
    expect(isHumanSessionRequest({ user: HUMAN })).toBe(true);
    expect(isHumanSessionRequest(null)).toBe(false);
  });

  it('refuses a service principal request (no req.user) and a missing user', () => {
    expect(refusal(() => i.intercept(ctx({ servicePrincipal: SERVICE }), handler())).body).toMatchObject({ code: 'HUMAN_SESSION_REQUIRED' });
    expect(refusal(() => i.intercept(ctx({}), handler())).status).toBe(403);
    expect(refusal(() => i.intercept(ctx({ user: null }), handler())).status).toBe(403);
  });

  it('never echoes a token in the refusal', () => {
    const r = refusal(() => i.intercept(ctx({ user: { ...API_TOKEN, token: 'SECRET-TOKEN' }, headers: { authorization: 'Bearer SECRET-TOKEN' } }), handler()));
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });
});
