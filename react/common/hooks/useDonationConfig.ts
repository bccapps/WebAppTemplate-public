/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { donationApi, DonationPublicConfig } from '../services/donationApi';

export type UseDonationConfigResult =
  | { status: 'loading'; config: null }
  | { status: 'error'; config: null }
  | { status: 'ready'; config: DonationPublicConfig };

/**
 * `common` has no TanStack Query (reserved for the `user` module) — a plain
 * fetch-on-mount hook is the established pattern here.
 */
export function useDonationConfig(): UseDonationConfigResult {
  const [result, setResult] = useState<UseDonationConfigResult>({ status: 'loading', config: null });

  useEffect(() => {
    let cancelled = false;
    donationApi
      .getPublicConfig()
      .then((config) => {
        if (!cancelled) setResult({ status: 'ready', config });
      })
      .catch(() => {
        if (!cancelled) setResult({ status: 'error', config: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return result;
}
