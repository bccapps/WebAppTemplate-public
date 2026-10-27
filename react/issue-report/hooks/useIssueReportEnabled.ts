/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { issueReportApi } from '../services/IssueReportApi';

/**
 * Whether the report button may show: `active` (a signed-in user of an app with accounts) and the back says
 * `enabled`. The config is fetched only once active, then cached for the page; a failure means hidden.
 */
export function useIssueReportEnabled(active: boolean): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    issueReportApi
      .getConfig()
      .then((config) => {
        if (!cancelled) setEnabled(config?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return active && enabled;
}
