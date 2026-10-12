/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModuleConfigService } from '../ModuleConfigService';
import {
  EmailProviderClient,
  EmailQuota,
  FetchEventsParams,
  ProviderEvent,
  ProviderEventType,
  SendCorrelation,
  UNAVAILABLE_QUOTA,
} from './EmailProviderClient';

const API_BASE = 'https://api.brevo.com/v3';

/** `/v3/smtp/statistics/events` refuses a window wider than 90 days. */
const MAX_EVENT_WINDOW_DAYS = 90;

/**
 * Event names as they appear in webhook payloads and in the events report.
 * The two vocabularies differ slightly (`soft_bounce` on the webhook,
 * `softBounces` on the report), so both spellings are mapped here.
 */
const EVENT_MAP: Record<string, ProviderEventType> = {
  request: 'sent',
  requests: 'sent',
  delivered: 'delivered',
  opened: 'opened',
  unique_opened: 'opened',
  uniqueopened: 'opened',
  proxy_open: 'opened',
  unique_proxy_open: 'opened',
  loadedbyproxy: 'opened',
  click: 'clicked',
  clicks: 'clicked',
  soft_bounce: 'bounced',
  softbounces: 'bounced',
  hard_bounce: 'bounced',
  hardbounces: 'bounced',
  bounces: 'bounced',
  blocked: 'blocked',
  spam: 'spam',
  invalid_email: 'invalid',
  invalid: 'invalid',
  deferred: 'deferred',
  unsubscribed: 'unsubscribed',
  error: 'error',
};

/**
 * Brevo, reached over its v3 REST API.
 *
 * Two things to know before touching this class:
 *
 * - **The REST credential is not the SMTP one.** The relay authenticates with an
 *   SMTP key while the API expects an `xkeysib-…` key in an `api-key` header,
 *   which is why `common_email_brevoRestApiKey` exists separately from
 *   `common_email_brevoApiKey`.
 * - **Polling is rate-limited to 300 requests/hour** on `/v3/smtp/*` for
 *   standard plans, and the documentation tells you to use webhooks instead.
 *   `fetchEvents` is therefore a reconciliation net, not the primary path.
 */
@Injectable()
export class BrevoProviderClient implements EmailProviderClient {
  readonly provider = 'brevo';

  private readonly logger = new Logger(BrevoProviderClient.name);

  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  private getValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '').trim();
  }

  private apiKey(): string {
    return this.getValue('common_email_brevoRestApiKey');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'api-key': this.apiKey(), Accept: 'application/json', ...(init?.headers ?? {}) },
      });
      if (!response.ok) {
        this.logger.warn(`Brevo ${init?.method ?? 'GET'} ${path} → HTTP ${response.status}`);
        return null;
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (err) {
      this.logger.warn(`Brevo ${init?.method ?? 'GET'} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * `X-Mailin-custom` is the documented custom header Brevo echoes back on every
   * transactional webhook event. `tags` has no confirmed SMTP header name in the
   * official documentation, so the campaign reference travels inside the custom
   * value too and correlation never depends on a tag surviving the relay.
   */
  buildSendHeaders(correlation: SendCorrelation): Record<string, string> {
    return {
      'X-Mailin-custom': JSON.stringify({ customId: correlation.customId, campaign: correlation.campaignRef }),
      'X-Mailin-Tag': correlation.campaignRef,
    };
  }

  async getQuota(monthlyAllowance: number): Promise<EmailQuota> {
    if (!this.isConfigured()) {
      return UNAVAILABLE_QUOTA(this.provider, 'common.email.quota.notConfigured');
    }

    const account = await this.request<{ plan?: { credits?: number; creditsType?: string; type?: string }[] }>('/account');
    if (!account?.plan) {
      return UNAVAILABLE_QUOTA(this.provider, 'common.email.quota.fetchFailed');
    }

    // `plan` also carries an SMS line; only the e-mail send limit is relevant.
    const emailPlan = account.plan.find((entry) => entry.type !== 'sms' && entry.creditsType === 'sendLimit')
      ?? account.plan.find((entry) => entry.type !== 'sms');
    if (!emailPlan || emailPlan.credits == null) {
      return UNAVAILABLE_QUOTA(this.provider, 'common.email.quota.fetchFailed');
    }

    return {
      provider: this.provider,
      source: 'api',
      remaining: Math.max(0, Math.floor(Number(emailPlan.credits))),
      allowance: monthlyAllowance > 0 ? monthlyAllowance : null,
      sentThisMonth: null,
    };
  }

  async fetchEvents({ campaignRef, since }: FetchEventsParams): Promise<ProviderEvent[]> {
    if (!this.isConfigured()) return [];

    const oldest = new Date(Date.now() - MAX_EVENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const startDate = since > oldest ? since : oldest;
    const query = new URLSearchParams({
      limit: '2500',
      startDate: startDate.toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      tags: JSON.stringify([campaignRef]),
    });

    const payload = await this.request<{
      events?: { date?: string; email?: string; event?: string; messageId?: string; reason?: string; link?: string; tag?: string }[];
    }>(`/smtp/statistics/events?${query}`);

    return (payload?.events ?? []).map((row) => ({
      type: EVENT_MAP[String(row.event ?? '').toLowerCase()] ?? 'error',
      email: String(row.email ?? ''),
      // The report does not carry X-Mailin-custom; correlation falls back to the
      // message id, which we record at send time.
      customId: null,
      messageId: row.messageId ? String(row.messageId) : null,
      at: row.date ? new Date(row.date) : new Date(),
      reason: row.reason ?? null,
      url: row.link ?? null,
    }));
  }

  parseWebhook(payload: unknown): ProviderEvent[] {
    // A batched webhook posts `{ items: [...] }`; a plain one posts the event itself.
    const container = payload as { items?: unknown[] } | undefined;
    const rows = Array.isArray(payload) ? payload : Array.isArray(container?.items) ? container.items : [payload];
    const events: ProviderEvent[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const item = row as Record<string, unknown>;
      const type = EVENT_MAP[String(item.event ?? '').toLowerCase()];
      if (!type) continue;

      events.push({
        type,
        email: String(item.email ?? ''),
        customId: parseCustomValue(item['X-Mailin-custom']),
        messageId: item['message-id'] ? String(item['message-id']) : null,
        // `ts_event` is UTC while `date` is CET/CEST — always prefer the epoch.
        at: item.ts_event ? new Date(Number(item.ts_event) * 1000) : new Date(),
        reason: item.reason ? String(item.reason) : null,
        url: item.link ? String(item.link) : null,
      });
    }

    return events;
  }

  async registerWebhook(url: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const existing = await this.request<{ webhooks?: { url?: string }[] }>('/webhooks?type=transactional');
    if (existing?.webhooks?.some((hook) => hook.url === url)) return true;

    const created = await this.request<{ id?: number }>('/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        type: 'transactional',
        // Batched delivery keeps a 2 000-recipient burst from turning into
        // thousands of individual POSTs against our endpoint.
        batched: true,
        events: ['delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'deferred', 'click', 'opened', 'unsubscribed'],
        description: 'Communications tracking',
      }),
    });

    return created != null;
  }
}

/**
 * `X-Mailin-custom` is a free-form string. We write JSON into it, but a value
 * set outside this application may be anything — never let a parse failure
 * abort a whole webhook batch.
 */
function parseCustomValue(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw);
  try {
    const parsed = JSON.parse(text) as { customId?: string };
    return parsed?.customId ? String(parsed.customId) : null;
  } catch {
    return text || null;
  }
}
