/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MailjetProviderClient } from './MailjetProviderClient';

const CONFIGURED: Record<string, string> = {
  common_email_mailjetApiKey: 'public-key',
  common_email_mailjetSecretKey: 'secret-key',
};

const buildClient = (values: Record<string, string> = CONFIGURED): MailjetProviderClient =>
  new MailjetProviderClient({ getDecryptedValue: (key: string) => values[key] ?? '' } as never);

const mockFetch = (payload: unknown, ok = true): jest.Mock => {
  const fetchMock = jest.fn(() =>
    Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(payload) }),
  );
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock as unknown as jest.Mock;
};

describe('MailjetProviderClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  describe('getQuota', () => {
    it('reports unavailable when no credentials are configured', async () => {
      const quota = await buildClient({}).getQuota(10_000);

      expect(quota.source).toBe('unavailable');
      expect(quota.remaining).toBeNull();
      expect(quota.reasonKey).toBe('common.email.quota.notConfigured');
    });

    it('derives the remaining balance from the month-to-date volume and the stated allowance', async () => {
      mockFetch({ Data: [{ MessageSentCount: 400 }, { MessageSentCount: 350 }] });

      const quota = await buildClient().getQuota(10_000);

      // Mailjet publishes no credit endpoint, so the figure is computed — and
      // says so, rather than passing itself off as a provider balance.
      expect(quota.source).toBe('computed');
      expect(quota.sentThisMonth).toBe(750);
      expect(quota.allowance).toBe(10_000);
      expect(quota.remaining).toBe(9_250);
    });

    it('never reports a negative balance once the allowance is exceeded', async () => {
      mockFetch({ Data: [{ MessageSentCount: 12_000 }] });

      const quota = await buildClient().getQuota(10_000);

      expect(quota.remaining).toBe(0);
    });

    it('gives the volume but no balance when no allowance was entered', async () => {
      mockFetch({ Data: [{ MessageSentCount: 120 }] });

      const quota = await buildClient().getQuota(0);

      expect(quota.source).toBe('unavailable');
      expect(quota.sentThisMonth).toBe(120);
      expect(quota.remaining).toBeNull();
      expect(quota.reasonKey).toBe('common.email.quota.noMailjetBalance');
    });

    it('reports unavailable rather than zero when the API call fails', async () => {
      mockFetch({}, false);

      const quota = await buildClient().getQuota(10_000);

      expect(quota.source).toBe('unavailable');
      expect(quota.remaining).toBeNull();
      expect(quota.reasonKey).toBe('common.email.quota.fetchFailed');
    });

    it('queries statcounters over the current month at day resolution', async () => {
      const fetchMock = mockFetch({ Data: [] });

      await buildClient().getQuota(1000);

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('/statcounters?');
      expect(url).toContain('CounterSource=APIKey');
      expect(url).toContain('CounterResolution=Day');
      // FromTS is mandatory at anything other than Lifetime resolution.
      expect(url).toContain('FromTS=');
    });
  });

  describe('buildSendHeaders', () => {
    it('attaches the correlation id and the campaign grouping header', () => {
      const headers = buildClient().buildSendHeaders({ customId: 'c1r2', campaignRef: 'comm-1' });

      expect(headers['X-MJ-CustomID']).toBe('c1r2');
      expect(headers['X-Mailjet-Campaign']).toBe('comm-1');
    });

    it('truncates the campaign reference to the documented 255-character limit', () => {
      const headers = buildClient().buildSendHeaders({ customId: 'c1r2', campaignRef: 'x'.repeat(400) });

      expect(headers['X-Mailjet-Campaign']).toHaveLength(255);
    });
  });

  describe('parseWebhook', () => {
    it('accepts a single event and an array of events alike', () => {
      const client = buildClient();
      const single = { event: 'open', email: 'a@b.c', time: 1_700_000_000, CustomID: 'c1r2', MessageID: 99 };

      expect(client.parseWebhook(single)).toHaveLength(1);
      expect(client.parseWebhook([single, single])).toHaveLength(2);
    });

    it('maps a blocked bounce to a block rather than a bounce', () => {
      const [event] = buildClient().parseWebhook({ event: 'bounce', email: 'a@b.c', blocked: true });

      expect(event.type).toBe('blocked');
    });

    it('keeps a real bounce as a bounce', () => {
      const [event] = buildClient().parseWebhook({ event: 'bounce', email: 'a@b.c', blocked: false });

      expect(event.type).toBe('bounced');
    });

    it('ignores an event type it does not know', () => {
      expect(buildClient().parseWebhook({ event: 'something-new', email: 'a@b.c' })).toEqual([]);
    });

    it('carries the custom id and the click target through', () => {
      const [event] = buildClient().parseWebhook({
        event: 'click',
        email: 'a@b.c',
        CustomID: 'c7r9',
        url: 'https://example.com/x',
        time: 1_700_000_000,
      });

      expect(event.customId).toBe('c7r9');
      expect(event.url).toBe('https://example.com/x');
      expect(event.at).toEqual(new Date(1_700_000_000 * 1000));
    });
  });
});
