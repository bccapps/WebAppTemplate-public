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

/** Minimal `HttpResult`: the callback of the queued outcome fires once all handlers are attached. */
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
  },
}));
vi.mock('../../common/services/ConfigurationService', () => ({
  configurationService: { getApiUrl: (moduleId: string) => (moduleId === 'issue-report' ? '/api/v1' : 'wrong') },
}));

import { issueReportApi, resetIssueReportConfigCache } from './IssueReportApi';

beforeEach(() => {
  calls.length = 0;
  outcomes = [];
  resetIssueReportConfigCache();
});

describe('issueReportApi', () => {
  it('builds the module URLs from getApiUrl("issue-report")', async () => {
    outcomes = [
      { kind: 'then', value: { number: 4 } },
      { kind: 'then', value: [] },
    ];
    expect(await issueReportApi.create({ title: 'Bug', description: 'x' })).toEqual({ number: 4 });
    expect(await issueReportApi.mine()).toEqual([]);
    expect(calls).toEqual([
      { method: 'POST', url: '/api/v1/issue-reports', body: { title: 'Bug', description: 'x' } },
      { method: 'GET', url: '/api/v1/issue-reports/mine' },
    ]);
  });

  it('fetches the config once per page, but not a failed answer', async () => {
    outcomes = [
      { kind: 'error', value: { statusCode: 0 } },
      { kind: 'then', value: { enabled: true } },
    ];
    await expect(issueReportApi.getConfig()).rejects.toEqual({ statusCode: 0 });
    expect(await issueReportApi.getConfig()).toEqual({ enabled: true });
    expect(await issueReportApi.getConfig()).toEqual({ enabled: true });
    expect(calls.filter((call) => call.url.endsWith('/config'))).toHaveLength(2);
  });

  it('rejects with the error payload on 400, 401 and network errors', async () => {
    outcomes = [
      { kind: 'fail', value: { statusCode: 400 } },
      { kind: 'notAuthorized', value: { statusCode: 401 } },
      { kind: 'error', value: { statusCode: 502 } },
    ];
    for (const statusCode of [400, 401, 502]) {
      await expect(issueReportApi.create({ title: 'Bug', description: 'x' })).rejects.toEqual({ statusCode });
    }
  });
});
