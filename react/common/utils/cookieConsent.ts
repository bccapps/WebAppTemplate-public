/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { httpService } from '../core/http/HttpService';
import { configurationService } from '../services/ConfigurationService';

export const COOKIE_CONSENT_COOKIE = 'vx_cookie_consent';
/** CNIL consent-validity window: 6 months. Matches CookieConsentRetentionCronService's own retention window. */
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 * 6;
/** Dispatched on every setCookieConsent() call so a mounted loader (e.g. TrackingScriptLoader) can react immediately instead of requiring a page reload. */
export const COOKIE_CONSENT_CHANGED_EVENT = 'vx:cookie-consent-changed';

export type CookieConsentCategories = { necessary: true; audienceMeasurement: boolean };
type StoredConsent = CookieConsentCategories & { consentedAt: string };

/** Reads the current consent choice from the cookie. Returns null when absent/expired/malformed — the banner shows. */
export function getCookieConsent(): StoredConsent | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(COOKIE_CONSENT_COOKIE + '='));
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match.split('=').slice(1).join('='))) as StoredConsent;
  } catch {
    return null;
  }
}

/**
 * Whether a given non-necessary category is currently consented to. This is the gate any
 * analytics loader MUST call before injecting its script — see `tracking` module's
 * `TrackingScriptLoader.tsx` (Umami) for the current consumer. Umami is cookieless by default
 * (rotating hash, no persistent tracking cookie), so the CNIL 13-month audience-measurement
 * cookie cap doesn't apply to it in practice — but a future swap to a cookie-based tool would
 * need to respect that limit on its own cookies.
 */
export function hasConsent(category: keyof Omit<CookieConsentCategories, 'necessary'>): boolean {
  return getCookieConsent()?.[category] === true;
}

/** Persists the choice client-side (6-month cookie) and fires a non-blocking proof-of-consent log to the backend. */
export function setCookieConsent(categories: CookieConsentCategories): void {
  const stored: StoredConsent = { ...categories, consentedAt: new Date().toISOString() };
  document.cookie = `${COOKIE_CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(stored))}; path=/; max-age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax`;
  window.dispatchEvent(new Event(COOKIE_CONSENT_CHANGED_EVENT));

  httpService
    .post(`${configurationService.getApiUrl('common')}/cookie-consent`, { categories })
    .fail(() => undefined)
    .error(() => undefined);
}
