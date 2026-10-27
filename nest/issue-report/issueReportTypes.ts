/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Shapes and bounds of an issue report. The bounds mirror the Agent Hub intake contract
 * (`POST /api/v1/issue-intake/issues`): a report the app accepts is never refused by the hub for its size.
 */

export const ISSUE_REPORT_STATUSES = ['open', 'closed'] as const;
export type IssueReportStatus = (typeof ISSUE_REPORT_STATUSES)[number];

/** Closure reasons known to the hub; any other value is kept as `manual` (generic closure notice). */
export const ISSUE_REPORT_CLOSED_REASONS = ['fixed', 'dropped', 'manual'] as const;
export type IssueReportClosedReason = (typeof ISSUE_REPORT_CLOSED_REASONS)[number];

export const ISSUE_REPORT_TITLE_MIN = 3;
export const ISSUE_REPORT_TITLE_MAX = 200;
export const ISSUE_REPORT_DESCRIPTION_MAX = 10_000;
export const ISSUE_REPORT_PAGE_URL_MAX = 500;
export const ISSUE_REPORT_APP_VERSION_MAX = 64;
export const ISSUE_REPORT_USER_AGENT_MAX = 300;
/** Longest raw `pageUrl` looked at before its query and fragment are dropped (anything longer is refused). */
export const ISSUE_REPORT_RAW_URL_MAX = 2_000;

/** Reports a user may send per rolling hour (same budget as the hub's per-reporter limit). */
export const ISSUE_REPORTS_PER_USER_PER_HOUR = 10;
/** Rows returned by `GET /issue-reports/mine`, newest first. */
export const ISSUE_REPORTS_MINE_LIMIT = 50;
/** Numbers per `GET …/issues/status` call (hub maximum). */
export const ISSUE_HUB_STATUS_BATCH = 100;
/** Open reports looked at per status run (oldest first); the rest wait for the next run. */
export const ISSUE_REPORT_SYNC_MAX = 1_000;
/** Closure e-mails attempted per status run. */
export const ISSUE_REPORT_NOTIFY_BATCH = 100;

/** A report as the reporter sees it (`GET /issue-reports/mine`). */
export interface IssueReportView {
  id: string;
  number: number;
  title: string;
  status: IssueReportStatus;
  closedReason: IssueReportClosedReason | null;
  closedAt: string | null;
  createdAt: string;
}

/** One entry of the hub's status answer, already validated. */
export interface HubIssueStatus {
  number: number;
  status: IssueReportStatus;
  closedReason: IssueReportClosedReason | null;
  closedAt: Date | null;
}
