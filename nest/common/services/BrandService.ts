/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { ModuleConfigService } from './ModuleConfigService';

export type SocialNetwork = 'x' | 'youtube' | 'linkedin' | 'instagram' | 'telegram' | 'discord';

export interface SocialLink {
  key: SocialNetwork;
  label: string;
  url: string;
}

export interface BrandIdentity {
  siteUrl: string;
  siteName: string;
  logoUrl: string;
  headerBannerUrl: string;
  accentColor: string;
  legalLine: string;
  postalAddress: string;
  socials: SocialLink[];
}

/** Display order in footers; the label doubles as the fallback when no icon exists. */
const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  x: 'X',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  telegram: 'Telegram',
  discord: 'Discord',
};

const DEFAULT_ACCENT = '#F4B000';

/**
 * Site identity as the backend sees it — see `brandConfigSchema`.
 *
 * Anything the backend renders for the outside world (e-mails, notifications,
 * invoices) needs absolute URLs, and the frontend's `VITE_APP_URL` is not
 * readable from here. `absoluteUrl()` is the single place that turns an
 * app-relative path into something a mail client can follow, so a missing
 * `common_brand_siteUrl` fails in one obvious spot rather than producing dozens
 * of silently broken links.
 */
@Injectable()
export class BrandService {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  private getValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '').trim();
  }

  /** Site root, without a trailing slash. Empty when not configured yet. */
  getSiteUrl(): string {
    return this.getValue('common_brand_siteUrl').replace(/\/+$/, '');
  }

  /**
   * Backend's own public root, without a trailing slash — falls back to the
   * site URL when unset (front and back sharing one domain/nginx).
   *
   * Needed because a callback the OUTSIDE WORLD calls back into (a mail
   * client fetching the open pixel, a click redirect, an e-mail provider's
   * delivery webhook) must resolve on the backend host. When front and back
   * are deployed on different domains (e.g. a static front on Cloudflare
   * Pages plus a separate API host), `common_brand_siteUrl` only reaches the
   * front's static assets and 404s/falls back to the SPA for these paths.
   */
  getApiUrl(): string {
    return this.getValue('common_brand_apiUrl').replace(/\/+$/, '') || this.getSiteUrl();
  }

  getSiteName(): string {
    return this.getValue('common_brand_siteName');
  }

  getAccentColor(): string {
    const color = this.getValue('common_brand_accentColor');
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_ACCENT;
  }

  /**
   * Absolute URL for an app path. Returns an empty string when no site URL is
   * configured: callers hide the link rather than emit a dead relative one.
   */
  absoluteUrl(path: string): string {
    const base = this.getSiteUrl();
    if (!base) return '';
    return `${base}/${String(path ?? '').replace(/^\/+/, '')}`;
  }

  /** Same as {@link absoluteUrl}, resolved against the backend host — see {@link getApiUrl}. */
  apiAbsoluteUrl(path: string): string {
    const base = this.getApiUrl();
    if (!base) return '';
    return `${base}/${String(path ?? '').replace(/^\/+/, '')}`;
  }

  /** Logo as an absolute URL — an app-relative value is resolved against the site URL. */
  getLogoUrl(): string {
    const logo = this.getValue('common_brand_logoUrl');
    if (!logo) return '';
    return /^https?:\/\//i.test(logo) ? logo : this.absoluteUrl(logo);
  }

  /**
   * Full-width e-mail header banner as an absolute URL — an app-relative
   * value is resolved against the site URL, same as {@link getLogoUrl}. Used
   * by `EmailLayoutService.renderDefaultHeaderContent()` in place of the
   * logo+wordmark composition when set; empty (the default) keeps that
   * composition so an app with no banner asset of its own renders nothing
   * broken.
   */
  getHeaderBannerUrl(): string {
    const banner = this.getValue('common_brand_headerBannerUrl');
    if (!banner) return '';
    return /^https?:\/\//i.test(banner) ? banner : this.absoluteUrl(banner);
  }

  /** Only the networks that actually carry a URL — an empty key renders nothing. */
  getSocialLinks(): SocialLink[] {
    return (Object.keys(SOCIAL_LABELS) as SocialNetwork[])
      .map((key) => ({ key, label: SOCIAL_LABELS[key], url: this.getValue(`common_social_${key}`) }))
      .filter((link) => link.url.length > 0);
  }

  getIdentity(): BrandIdentity {
    return {
      siteUrl: this.getSiteUrl(),
      siteName: this.getSiteName(),
      logoUrl: this.getLogoUrl(),
      headerBannerUrl: this.getHeaderBannerUrl(),
      accentColor: this.getAccentColor(),
      legalLine: this.getValue('common_brand_legalLine'),
      postalAddress: this.getValue('common_brand_postalAddress'),
      socials: this.getSocialLinks(),
    };
  }
}
