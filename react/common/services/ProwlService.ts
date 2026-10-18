/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import axios from 'axios';

const DEFAULT_ENDPOINT = 'https://api.prowlapp.com/publicapi';
const DEFAULT_APPLICATION = 'Unknown Application';

/**
 * Prowl push from the browser, with a key the CALLER supplies (e.g. the signed-in user's own
 * Prowl key from their profile). Never read from a VITE_* variable: those are inlined into the
 * public bundle, so an app-wide key there is readable by every visitor. App-wide notifications
 * belong to the back (`nest/common` ProwlService, key in back/.env).
 */
class ProwlService {
  private endpoint =
    import.meta.env.VITE_PROWL_API_URL ?? DEFAULT_ENDPOINT;
  private application =
    import.meta.env.VITE_PROJECT_NAME ?? DEFAULT_APPLICATION;

  async notify(event: string, description: string, options: { apiKey: string; application?: string }) {
    const apiKey = options?.apiKey;
    if (!apiKey) {
      console.warn('Prowl API key missing; notification skipped');
      return;
    }

    const url = `${this.endpoint}/add`;
    const body = new URLSearchParams({
      apikey: apiKey,
      application: options.application ?? this.application,
      event,
      description,
    });

    await axios.post(url, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}

export const prowlService = new ProwlService();
