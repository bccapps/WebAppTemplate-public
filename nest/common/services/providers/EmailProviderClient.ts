/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Where a remaining-sends figure came from.
 *
 * `api` — the provider returned a real balance.
 * `computed` — no balance endpoint exists, so it was derived from the volume
 *   already sent this month against an allowance entered in the configuration.
 * `unavailable` — nothing trustworthy could be produced.
 *
 * Callers must surface this to the admin. Mailjet in particular exposes **no**
 * credit endpoint whatsoever, and showing a made-up balance before a send to
 * thousands of contacts would be worse than showing none.
 */
export type QuotaSource = 'api' | 'computed' | 'unavailable';

export interface EmailQuota {
  provider: string;
  source: QuotaSource;
  /** Remaining sends, or null when the provider cannot tell us. */
  remaining: number | null;
  /** Monthly allowance used for the `computed` path. */
  allowance: number | null;
  /** Volume already sent over the current calendar month, when knowable. */
  sentThisMonth: number | null;
  /** i18n key explaining a null `remaining`. */
  reasonKey?: string;
}

export type ProviderEventType =
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'blocked'
  | 'spam'
  | 'unsubscribed'
  | 'deferred'
  | 'invalid'
  | 'error';

export interface ProviderEvent {
  type: ProviderEventType;
  email: string;
  /** The identifier we attached at send time, when the provider echoes it back. */
  customId: string | null;
  messageId: string | null;
  at: Date;
  reason?: string | null;
  /** Target of a click event. */
  url?: string | null;
}

export interface FetchEventsParams {
  /** Campaign grouping reference: a Mailjet campaign name, a Brevo tag. */
  campaignRef: string;
  since: Date;
}

export interface SendCorrelation {
  /** Per-recipient identifier, unique across the whole application. */
  customId: string;
  /** Groups every message of one communication. */
  campaignRef: string;
}

/**
 * The slice of a transactional provider this application depends on, kept
 * deliberately small so a third provider only has to implement five methods.
 */
export interface EmailProviderClient {
  readonly provider: string;

  /** True when the credentials needed by the REST calls below are present. */
  isConfigured(): boolean;

  getQuota(monthlyAllowance: number): Promise<EmailQuota>;

  fetchEvents(params: FetchEventsParams): Promise<ProviderEvent[]>;

  /** SMTP headers that make the events above correlatable back to a recipient. */
  buildSendHeaders(correlation: SendCorrelation): Record<string, string>;

  /** Normalises a webhook payload; returns an empty array when unrecognised. */
  parseWebhook(payload: unknown): ProviderEvent[];

  /** Registers our public callback with the provider. */
  registerWebhook(url: string): Promise<boolean>;
}

/** Start of the current calendar month, UTC — the window a monthly allowance is counted over. */
export function startOfCurrentMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export const UNAVAILABLE_QUOTA = (provider: string, reasonKey: string): EmailQuota => ({
  provider,
  source: 'unavailable',
  remaining: null,
  allowance: null,
  sentThisMonth: null,
  reasonKey,
});
