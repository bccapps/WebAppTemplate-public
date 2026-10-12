/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { ModuleConfigService } from '../ModuleConfigService';
import { BrandService } from '../BrandService';
import { MailjetProviderClient } from './MailjetProviderClient';
import { BrevoProviderClient } from './BrevoProviderClient';
import {
  EmailProviderClient,
  EmailQuota,
  ProviderEvent,
  SendCorrelation,
  UNAVAILABLE_QUOTA,
} from './EmailProviderClient';

export interface SendCostEstimate {
  recipientCount: number;
  /** Null when no unit price is configured — the UI then shows nothing, not zero. */
  estimatedCost: number | null;
  currency: string;
  costPer1000: number | null;
}

/**
 * Single entry point to whichever transactional provider is currently selected.
 *
 * Consumers never branch on the provider name: they ask for headers, a quota or
 * a parsed webhook and get an answer that is correct for the active
 * configuration — including the honest "this provider cannot tell us" answer
 * when that is the truth.
 */
@Injectable()
export class EmailProviderService {
  constructor(
    private readonly moduleConfigService: ModuleConfigService,
    private readonly brandService: BrandService,
    private readonly mailjetClient: MailjetProviderClient,
    private readonly brevoClient: BrevoProviderClient,
  ) {}

  private getValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '').trim();
  }

  private getNumber(key: string): number {
    const parsed = Number(this.getValue(key));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  getProviderName(): string {
    return this.getValue('common_email_provider') || 'none';
  }

  /** Null for `none` and for a bare SMTP relay, which has no statistics API at all. */
  getClient(): EmailProviderClient | null {
    switch (this.getProviderName()) {
      case 'mailjet':
        return this.mailjetClient;
      case 'brevo':
        return this.brevoClient;
      default:
        return null;
    }
  }

  /**
   * Correlation headers for one message. Returns an empty object on a bare SMTP
   * relay: nothing consumes them there, and sending unknown `X-` headers to an
   * arbitrary relay only risks tripping spam heuristics.
   */
  buildSendHeaders(correlation: SendCorrelation): Record<string, string> {
    return this.getClient()?.buildSendHeaders(correlation) ?? {};
  }

  async getQuota(): Promise<EmailQuota> {
    const client = this.getClient();
    if (!client) {
      return UNAVAILABLE_QUOTA(this.getProviderName(), 'common.email.quota.noProviderApi');
    }
    return client.getQuota(this.getNumber('common_email_monthlyAllowance'));
  }

  /**
   * Cost of a send at the unit price entered in the configuration. Neither
   * provider exposes pricing over the API, so this is a stated price, not a
   * quoted one — the UI labels it as an estimate.
   */
  estimateCost(recipientCount: number): SendCostEstimate {
    const costPer1000 = this.getNumber('common_email_costPer1000');
    const currency = this.getValue('common_email_currency') || 'EUR';
    return {
      recipientCount,
      costPer1000: costPer1000 > 0 ? costPer1000 : null,
      estimatedCost: costPer1000 > 0 ? (recipientCount / 1000) * costPer1000 : null,
      currency,
    };
  }

  async fetchEvents(campaignRef: string, since: Date): Promise<ProviderEvent[]> {
    const client = this.getClient();
    if (!client?.isConfigured()) return [];
    return client.fetchEvents({ campaignRef, since });
  }

  parseWebhook(provider: string, payload: unknown): ProviderEvent[] {
    // Keyed on the path segment rather than the active configuration: events for
    // a provider that was just switched away from must still be accepted.
    if (provider === 'mailjet') return this.mailjetClient.parseWebhook(payload);
    if (provider === 'brevo') return this.brevoClient.parseWebhook(payload);
    return [];
  }

  getWebhookSecret(): string {
    return this.getValue('common_email_webhookSecret');
  }

  /** Public callback URL, or an empty string when the API URL or secret is missing. */
  buildWebhookUrl(apiPrefix: string): string {
    const secret = this.getWebhookSecret();
    const provider = this.getProviderName();
    if (!secret || !this.brandService.getApiUrl()) return '';
    return this.brandService.apiAbsoluteUrl(`${apiPrefix}/communications/webhook/${provider}/${secret}`);
  }

  async registerWebhook(apiPrefix: string): Promise<boolean> {
    const client = this.getClient();
    const url = this.buildWebhookUrl(apiPrefix);
    if (!client || !url) return false;
    return client.registerWebhook(url);
  }
}
