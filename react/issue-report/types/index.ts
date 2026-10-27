/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** `GET /issue-reports/config`. */
export interface IssueReportConfig {
  enabled: boolean;
}

/** Body of `POST /issue-reports`. */
export interface IssueReportDraft {
  title: string;
  description: string;
  pageUrl?: string;
}

/** `201` answer of `POST /issue-reports`: the hub's number of the new issue. */
export interface IssueReportCreated {
  number: number;
}

export type IssueReportStatus = 'open' | 'closed';
export type IssueReportClosedReason = 'fixed' | 'dropped' | 'manual';

/** One entry of `GET /issue-reports/mine` (ISO dates). */
export interface IssueReportItem {
  id: string;
  number: number;
  title: string;
  status: IssueReportStatus;
  closedReason: IssueReportClosedReason | null;
  closedAt: string | null;
  createdAt: string;
}

/** Error payload handed by `HttpService` to `fail` / `error` / `notAuthorized`. */
export interface IssueReportHttpError {
  statusCode?: number;
  code?: string;
}
