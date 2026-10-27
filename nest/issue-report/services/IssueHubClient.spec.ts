/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { resetThrottleBuckets } from '../../common/utils/throttledFetch';
import { IssueHubClient, parseHubIssueStatus, readIssueHubConfig } from './IssueHubClient';

const TOKEN = 'ahi_0123456789abcdefSECRET';

interface Call {
  url: string;
  init: RequestInit;
}

/** Replaces the global `fetch` used by `throttledFetch`; answers are consumed in order (the last one repeats). */
function stubFetch(answers: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status,
      json: async () => answer.body ?? null,
      headers: { get: () => null },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const env = { ...process.env };
let logged: string[];

beforeEach(() => {
  resetThrottleBuckets();
  process.env.ISSUE_HUB_URL = 'https://hub.example.com/api/v1/issue-intake/';
  process.env.ISSUE_HUB_TOKEN = TOKEN;
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  }
});

afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});

describe('readIssueHubConfig', () => {
  it('is off without both variables, and says why when only one is set', () => {
    expect(readIssueHubConfig({})).toEqual({ config: null, problem: null });
    expect(readIssueHubConfig({ ISSUE_HUB_URL: 'https://hub.example.com' }).problem).toMatch(/both be set/);
    expect(readIssueHubConfig({ ISSUE_HUB_TOKEN: TOKEN }).problem).toMatch(/both be set/);
  });

  it('refuses a URL that is not plain http(s) and a malformed token, never echoing the token', () => {
    for (const url of ['ftp://hub', 'https://u:p@hub.example.com', 'https://hub.example.com?x=1', 'nope']) {
      expect(readIssueHubConfig({ ISSUE_HUB_URL: url, ISSUE_HUB_TOKEN: TOKEN }).config).toBeNull();
    }
    const bad = readIssueHubConfig({ ISSUE_HUB_URL: 'https://hub.example.com', ISSUE_HUB_TOKEN: 'has blank inside' });
    expect(bad.config).toBeNull();
    expect(bad.problem).not.toContain('blank inside');
  });

  it('drops the trailing slash of the base URL', () => {
    const { config } = readIssueHubConfig({ ISSUE_HUB_URL: 'https://hub.example.com/api/v1/issue-intake//', ISSUE_HUB_TOKEN: TOKEN });
    expect(config).toEqual({ baseUrl: 'https://hub.example.com/api/v1/issue-intake', token: TOKEN });
  });
});

describe('IssueHubClient.createIssue', () => {
  const payload = { title: 'Broken', body: 'It fails', reporterRef: '7' };

  it('POSTs the report with the Bearer token, once, and returns the hub number', async () => {
    const fetchStub = stubFetch([{ status: 201, body: { number: 12 } }]);
    try {
      const result = await new IssueHubClient().createIssue(payload);
      expect(result).toEqual({ ok: true, number: 12 });
      expect(fetchStub.calls).toHaveLength(1);
      const [{ url, init }] = fetchStub.calls;
      expect(url).toBe('https://hub.example.com/api/v1/issue-intake/issues');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init.body))).toEqual(payload);
    } finally {
      fetchStub.restore();
    }
  });

  it.each([
    [400, 'rejected'],
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s without retrying a POST', async (status, reason) => {
    const fetchStub = stubFetch([{ status, body: { message: 'x' } }]);
    try {
      expect(await new IssueHubClient().createIssue(payload)).toEqual({ ok: false, reason });
      expect(fetchStub.calls).toHaveLength(1);
    } finally {
      fetchStub.restore();
    }
  });

  it('treats a network error and a 2xx without number as unavailable', async () => {
    for (const answer of [new Error('ECONNREFUSED'), { status: 201, body: { number: 'twelve' } }]) {
      const fetchStub = stubFetch([answer]);
      try {
        expect(await new IssueHubClient().createIssue(payload)).toEqual({ ok: false, reason: 'unavailable' });
      } finally {
        fetchStub.restore();
      }
    }
  });

  it('does not call the hub when it is not configured', async () => {
    delete process.env.ISSUE_HUB_TOKEN;
    const fetchStub = stubFetch([{ status: 201, body: { number: 1 } }]);
    try {
      const client = new IssueHubClient();
      expect(client.isConfigured()).toBe(false);
      expect(await client.createIssue(payload)).toEqual({ ok: false, reason: 'unavailable' });
      expect(fetchStub.calls).toHaveLength(0);
    } finally {
      fetchStub.restore();
    }
  });

  it('never writes the token in a log line (refused token, plain http warning)', async () => {
    process.env.ISSUE_HUB_URL = 'http://hub.example.com/api/v1/issue-intake';
    const fetchStub = stubFetch([{ status: 401 }]);
    try {
      const client = new IssueHubClient();
      await client.createIssue(payload);
      await client.createIssue(payload);
      expect(logged.some((line) => line.includes('plain http'))).toBe(true);
      expect(logged.filter((line) => line.includes('refused the token'))).toHaveLength(1);
      expect(logged.join('\n')).not.toContain(TOKEN);
    } finally {
      fetchStub.restore();
    }
  });
});

describe('IssueHubClient.statusOf', () => {
  it('asks for the given numbers and keeps only valid entries for them', async () => {
    const fetchStub = stubFetch([
      {
        status: 200,
        body: {
          issues: [
            { number: 1, status: 'open', closedReason: null, closedAt: null },
            { number: 2, status: 'closed', closedReason: 'fixed', closedAt: '2026-10-27T10:00:00.000Z' },
            { number: 3, status: 'closed', closedReason: 'weird', closedAt: 'not a date' },
            { number: 99, status: 'closed', closedReason: 'fixed', closedAt: null },
            { number: 4, status: 'deleted' },
          ],
        },
      },
    ]);
    try {
      const statuses = await new IssueHubClient().statusOf([1, 2, 3, 4, -5]);
      expect(fetchStub.calls[0].url).toBe('https://hub.example.com/api/v1/issue-intake/issues/status?numbers=1,2,3,4');
      expect((fetchStub.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(statuses).toEqual([
        { number: 1, status: 'open', closedReason: null, closedAt: null },
        { number: 2, status: 'closed', closedReason: 'fixed', closedAt: new Date('2026-10-27T10:00:00.000Z') },
        { number: 3, status: 'closed', closedReason: 'manual', closedAt: null },
      ]);
    } finally {
      fetchStub.restore();
    }
  });

  it('returns null when the hub cannot be read or answers garbage', async () => {
    for (const answer of [{ status: 401 }, { status: 200, body: { nope: true } }]) {
      resetThrottleBuckets();
      const fetchStub = stubFetch([answer]);
      try {
        expect(await new IssueHubClient().statusOf([1])).toBeNull();
      } finally {
        fetchStub.restore();
      }
    }
  });

  it('parseHubIssueStatus ignores entries for numbers that were not asked', () => {
    expect(parseHubIssueStatus({ number: 5, status: 'open' }, new Set([4]))).toBeNull();
    expect(parseHubIssueStatus('x', new Set([4]))).toBeNull();
  });
});
