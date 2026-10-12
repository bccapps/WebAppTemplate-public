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
  startOfCurrentMonth,
} from './EmailProviderClient';

const API_BASE = 'https://api.mailjet.com/v3/REST';

/** `X-Mailjet-Campaign` is documented as at most 255 characters on a single line. */
const CAMPAIGN_REF_MAX_LENGTH = 255;

/** Mailjet's `Status` values on the /message resource, mapped onto our vocabulary. */
const MESSAGE_STATUS_MAP: Record<string, ProviderEventType> = {
  sent: 'sent',
  opened: 'opened',
  clicked: 'clicked',
  bounce: 'bounced',
  hardbounced: 'bounced',
  softbounced: 'bounced',
  blocked: 'blocked',
  spam: 'spam',
  unsub: 'unsubscribed',
  deferred: 'deferred',
  queued: 'sent',
  unknown: 'error',
};

/** Event names as they arrive on the Event API webhook. */
const WEBHOOK_EVENT_MAP: Record<string, ProviderEventType> = {
  sent: 'sent',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  blocked: 'blocked',
  spam: 'spam',
  unsub: 'unsubscribed',
};

/**
 * Mailjet, reached over its v3 REST API with the same key pair that
 * authenticates the SMTP relay.
 *
 * Two constraints shaped this class, both verified against the official
 * reference rather than assumed:
 *
 * - **There is no credit-balance endpoint.** `/myprofile`, `/user`, `/apikey`,
 *   `/apikeytotals` and `/sender` carry no quota, allowance or remaining-sends
 *   field. The best we can do is count what went out this month via
 *   `/statcounters` and subtract it from an allowance the admin typed in, which
 *   is why `getQuota` reports `source: 'computed'` and never pretends otherwise.
 * - **`/messagesentstatistics` is dead** for any account created after March
 *   2018, so per-message lookups go through `/message?CustomID=…` instead.
 */
@Injectable()
export class MailjetProviderClient implements EmailProviderClient {
  readonly provider = 'mailjet';

  private readonly logger = new Logger(MailjetProviderClient.name);

  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  private getValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '').trim();
  }

  isConfigured(): boolean {
    return Boolean(this.getValue('common_email_mailjetApiKey') && this.getValue('common_email_mailjetSecretKey'));
  }

  private authHeader(): string {
    const key = this.getValue('common_email_mailjetApiKey');
    const secret = this.getValue('common_email_mailjetSecretKey');
    return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
  }

  private async request<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(`Mailjet GET ${path} → HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (err) {
      this.logger.warn(`Mailjet GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  buildSendHeaders(correlation: SendCorrelation): Record<string, string> {
    return {
      'X-MJ-CustomID': correlation.customId,
      'X-Mailjet-Campaign': correlation.campaignRef.slice(0, CAMPAIGN_REF_MAX_LENGTH),
    };
  }

  /**
   * Volume sent this month, from `/statcounters` at day resolution. The API
   * caps a window at 100 × the resolution, so a calendar month always fits.
   */
  private async getSentThisMonth(): Promise<number | null> {
    const fromTs = Math.floor(startOfCurrentMonth().getTime() / 1000);
    const query = new URLSearchParams({
      CounterSource: 'APIKey',
      CounterTiming: 'Message',
      CounterResolution: 'Day',
      FromTS: String(fromTs),
      ToTS: String(Math.floor(Date.now() / 1000)),
    });
    const payload = await this.request<{ Data?: { MessageSentCount?: number }[] }>(`/statcounters?${query}`);
    if (!payload?.Data) return null;
    return payload.Data.reduce((total, row) => total + (Number(row.MessageSentCount) || 0), 0);
  }

  async getQuota(monthlyAllowance: number): Promise<EmailQuota> {
    if (!this.isConfigured()) {
      return UNAVAILABLE_QUOTA(this.provider, 'common.email.quota.notConfigured');
    }

    const sentThisMonth = await this.getSentThisMonth();
    if (sentThisMonth === null) {
      return UNAVAILABLE_QUOTA(this.provider, 'common.email.quota.fetchFailed');
    }
    if (!monthlyAllowance || monthlyAllowance <= 0) {
      // Honest partial answer: we know the volume, not the ceiling.
      return {
        provider: this.provider,
        source: 'unavailable',
        remaining: null,
        allowance: null,
        sentThisMonth,
        reasonKey: 'common.email.quota.noMailjetBalance',
      };
    }

    return {
      provider: this.provider,
      source: 'computed',
      remaining: Math.max(0, monthlyAllowance - sentThisMonth),
      allowance: monthlyAllowance,
      sentThisMonth,
    };
  }

  /**
   * Reconciliation path. Resolves the campaign name we set through
   * `X-Mailjet-Campaign` to its numeric id, then reads every message of that
   * campaign with its current status.
   */
  async fetchEvents({ campaignRef, since }: FetchEventsParams): Promise<ProviderEvent[]> {
    if (!this.isConfigured()) return [];

    const fromTs = Math.floor(since.getTime() / 1000);
    const campaigns = await this.request<{ Data?: { ID: number }[] }>(
      `/campaign?CustomCampaign=${encodeURIComponent(campaignRef)}&FromTS=${fromTs}`,
    );
    const campaignId = campaigns?.Data?.[0]?.ID;
    if (!campaignId) return [];

    const messages = await this.request<{
      Data?: { Status?: string; ContactAlt?: string; CustomID?: string; ID?: number; ArrivedAt?: string; StateID?: number }[];
    }>(`/message?Campaign=${campaignId}&ShowCustomID=true&ShowContactAlt=true&Limit=1000`);

    return (messages?.Data ?? []).map((row) => ({
      type: MESSAGE_STATUS_MAP[String(row.Status ?? '').toLowerCase()] ?? 'error',
      email: String(row.ContactAlt ?? ''),
      customId: row.CustomID ? String(row.CustomID) : null,
      messageId: row.ID != null ? String(row.ID) : null,
      at: row.ArrivedAt ? new Date(row.ArrivedAt) : new Date(),
      reason: row.StateID ? `state:${row.StateID}` : null,
    }));
  }

  /**
   * The Event API posts either a single event or an array of them, depending on
   * the callback version — accept both rather than depending on the setting.
   */
  parseWebhook(payload: unknown): ProviderEvent[] {
    const rows = Array.isArray(payload) ? payload : [payload];
    const events: ProviderEvent[] = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const item = row as Record<string, unknown>;
      const type = WEBHOOK_EVENT_MAP[String(item.event ?? '').toLowerCase()];
      if (!type) continue;

      // A bounce flagged `blocked` is a block, not a bounce — Mailjet ships both
      // on the same event name and only this flag separates them.
      const resolved: ProviderEventType = type === 'bounced' && item.blocked === true ? 'blocked' : type;

      events.push({
        type: resolved,
        email: String(item.email ?? ''),
        customId: item.CustomID ? String(item.CustomID) : null,
        messageId: item.MessageID != null ? String(item.MessageID) : null,
        at: item.time ? new Date(Number(item.time) * 1000) : new Date(),
        reason: item.error ? String(item.error) : null,
        url: item.url ? String(item.url) : null,
      });
    }

    return events;
  }

  async registerWebhook(url: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const eventTypes = ['sent', 'open', 'click', 'bounce', 'blocked', 'spam', 'unsub'];

    try {
      const existing = await this.request<{ Data?: { ID: number; Url: string }[] }>('/eventcallbackurl');
      const known = new Set((existing?.Data ?? []).filter((row) => row.Url === url).map((row) => row.ID));

      for (const eventType of eventTypes) {
        if (known.size > 0) break;
        const response = await fetch(`${API_BASE}/eventcallbackurl`, {
          method: 'POST',
          headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
          // Version 2 groups events and fires at most once a second, which the
          // reference explicitly recommends to stay clear of the rate limits.
          body: JSON.stringify({ EventType: eventType, Url: url, Version: 2, Status: 'alive' }),
        });
        if (!response.ok) {
          this.logger.warn(`Mailjet webhook registration for "${eventType}" → HTTP ${response.status}`);
        }
      }
      return true;
    } catch (err) {
      this.logger.warn(`Mailjet webhook registration failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
