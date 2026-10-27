/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Answer of `GET /api/v1/issue-reports/config` (public). Nothing about the hub (URL, token) is exposed. */
export class IssueReportConfigDto {
  /** `ISSUE_HUB_URL` and `ISSUE_HUB_TOKEN` are valid and the app has user accounts. */
  enabled!: boolean;
}
