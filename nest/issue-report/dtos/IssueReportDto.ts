/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { IssueReportClosedReason, IssueReportStatus, IssueReportView } from '../issueReportTypes';

/** A report of the signed-in user (`GET /api/v1/issue-reports/mine`). Dates are ISO strings. */
export class IssueReportDto implements IssueReportView {
  id!: string;
  /** Number of the issue on the hub, shown to the reporter (« n°12 »). */
  number!: number;
  title!: string;
  status!: IssueReportStatus;
  closedReason!: IssueReportClosedReason | null;
  closedAt!: string | null;
  createdAt!: string;
}
