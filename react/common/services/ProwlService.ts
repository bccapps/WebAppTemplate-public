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

class ProwlService {
  private endpoint =
    import.meta.env.VITE_PROWL_API_URL ?? DEFAULT_ENDPOINT;
  private application =
    import.meta.env.VITE_PROJECT_NAME ?? DEFAULT_APPLICATION;

  async notify(event: string, description: string, application?: string) {
    const apiKey =
      import.meta.env.VITE_PROWL_API_KEY ??
      (import.meta as any).env?.PROWL_API_KEY;

    if (!apiKey) {
      console.warn('PROWL_API_KEY is missing; notification skipped');
      return;
    }

    const url = `${this.endpoint}/add`;
    const body = new URLSearchParams({
      apikey: apiKey,
      application: application ?? this.application,
      event,
      description,
    });

    await axios.post(url, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}

export const prowlService = new ProwlService();
