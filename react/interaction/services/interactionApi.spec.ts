/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Outcome = { kind: 'then' | 'fail' | 'error' | 'notAuthorized'; value: unknown };
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let outcomes: Outcome[] = [];

function fakeResult() {
  const handlers: Record<string, (value: unknown) => void> = {};
  const outcome = outcomes.shift() ?? { kind: 'then', value: null };
  const result = {
    then: (cb: (value: unknown) => void) => ((handlers.then = cb), result),
    fail: (cb: (value: unknown) => void) => ((handlers.fail = cb), result),
    error: (cb: (value: unknown) => void) => ((handlers.error = cb), result),
    notAuthorized: (cb: (value: unknown) => void) => ((handlers.notAuthorized = cb), result),
  };
  queueMicrotask(() => handlers[outcome.kind]?.(outcome.value));
  return result;
}

vi.mock('../../common/core/http/HttpService', () => ({
  httpService: {
    get: (url: string) => (calls.push({ method: 'GET', url }), fakeResult()),
    post: (url: string, body: unknown) => (calls.push({ method: 'POST', url, body }), fakeResult()),
    put: (url: string, body: unknown) => (calls.push({ method: 'PUT', url, body }), fakeResult()),
    patch: (url: string, body: unknown) => (calls.push({ method: 'PATCH', url, body }), fakeResult()),
    delete: (url: string) => (calls.push({ method: 'DELETE', url }), fakeResult()),
  },
}));
vi.mock('../../common/services/ConfigurationService', () => ({
  configurationService: { getApiUrl: (moduleId: string) => (moduleId === 'interaction' ? '/api/v1' : 'wrong') },
}));

import { interactionApi, toApiError } from './interactionApi';

beforeEach(() => {
  calls.length = 0;
  outcomes = [];
});

describe('interactionApi', () => {
  it('builds the URLs from getApiUrl("interaction"), never a target in a URL', async () => {
    await interactionApi.channels();
    await interactionApi.configure('telegram', { mode: 'own' });
    await interactionApi.setState('browser', { enabled: false });
    await interactionApi.unsubscribeWebPush('https://push.test/secret-endpoint');
    await interactionApi.answer('t1', 'approve');
    await interactionApi.answer('t1', 'approve', 'proof-1');
    await interactionApi.markRead('all');
    await interactionApi.adminChannels({ userId: 3, kind: 'telegram' });
    await interactionApi.adminSetDisabled(3, 'telegram', true);
    expect(calls).toEqual([
      { method: 'GET', url: '/api/v1/interaction/me/channels' },
      { method: 'PUT', url: '/api/v1/interaction/me/channels/telegram', body: { mode: 'own' } },
      { method: 'PATCH', url: '/api/v1/interaction/me/channels/browser', body: { enabled: false } },
      { method: 'POST', url: '/api/v1/interaction/me/webpush/subscriptions/remove', body: { endpoint: 'https://push.test/secret-endpoint' } },
      { method: 'POST', url: '/api/v1/interaction/me/tickets/t1/answer', body: { actionId: 'approve' } },
      { method: 'POST', url: '/api/v1/interaction/me/tickets/t1/answer', body: { actionId: 'approve', stepUpProof: 'proof-1' } },
      { method: 'POST', url: '/api/v1/interaction/me/notices/read', body: { all: true } },
      { method: 'GET', url: '/api/v1/admin/interaction/channels?userId=3&kind=telegram' },
      { method: 'PATCH', url: '/api/v1/admin/interaction/users/3/channels/telegram', body: { adminDisabled: true } },
    ]);
    expect(calls.some((call) => call.url.includes('secret-endpoint'))).toBe(false);
  });

  it('rejects with { code, status, details } on every failure kind', async () => {
    outcomes = [
      { kind: 'error', value: { code: 'ALREADY_ANSWERED', statusCode: 409, raw: { details: { via: 'telegram' } } } },
      { kind: 'notAuthorized', value: { code: 'AUT', statusCode: 401 } },
    ];
    await expect(interactionApi.answer('t1', 'approve')).rejects.toEqual({ code: 'ALREADY_ANSWERED', status: 409, details: { via: 'telegram' } });
    await expect(interactionApi.inbox()).rejects.toEqual({ code: 'UNKNOWN', status: 401, details: null });
    expect(toApiError(undefined)).toEqual({ code: 'UNKNOWN', status: 0, details: null });
  });
});
