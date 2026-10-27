/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { IssueReportHttpError, IssueReportItem } from '../types';

/** Same bounds as the back (`nest/issue-report/issueReportTypes.ts`); the back checks them again. */
export const ISSUE_REPORT_TITLE_MIN = 3;
export const ISSUE_REPORT_TITLE_MAX = 200;
export const ISSUE_REPORT_DESCRIPTION_MAX = 10_000;
const PAGE_URL_MAX = 500;

export interface FieldError {
  /** i18n key of the message. */
  key: string;
  params?: (string | number)[];
}

export interface IssueReportFormErrors {
  title?: FieldError;
  description?: FieldError;
}

/** Errors to show on submit; empty object = valid. */
export function validateIssueReportForm(title: string, description: string): IssueReportFormErrors {
  const errors: IssueReportFormErrors = {};
  const cleanTitle = title.trim();
  if (!cleanTitle) errors.title = { key: 'issueReport.form.error.required' };
  else if (cleanTitle.length < ISSUE_REPORT_TITLE_MIN) errors.title = { key: 'issueReport.form.error.tooShort', params: [ISSUE_REPORT_TITLE_MIN] };
  else if (cleanTitle.length > ISSUE_REPORT_TITLE_MAX) errors.title = { key: 'issueReport.form.error.tooLong', params: [ISSUE_REPORT_TITLE_MAX] };
  const cleanDescription = description.trim();
  if (!cleanDescription) errors.description = { key: 'issueReport.form.error.required' };
  else if (cleanDescription.length > ISSUE_REPORT_DESCRIPTION_MAX) {
    errors.description = { key: 'issueReport.form.error.tooLong', params: [ISSUE_REPORT_DESCRIPTION_MAX] };
  }
  return errors;
}

/** Page the report is made from: origin and path only (a query or a fragment may hold a token or a code). */
export function currentPageUrl(location: Pick<Location, 'origin' | 'pathname'> | undefined = globalThis.location): string | undefined {
  if (!location) return undefined;
  const page = `${location.origin}${location.pathname}`;
  return page.length <= PAGE_URL_MAX ? page : undefined;
}

/** Message of a failed `POST /issue-reports`, from the HTTP status the back answered. */
export function errorMessageKey(error: unknown): string {
  const status = (error as IssueReportHttpError | null)?.statusCode;
  if (status === 400) return 'issueReport.error.invalid';
  if (status === 401) return 'issueReport.error.signedOut';
  if (status === 429) return 'issueReport.error.rateLimited';
  if (status === 503) return 'issueReport.error.unavailable';
  return 'issueReport.error.hubDown';
}

export type IssueReportTone = 'open' | 'fixed' | 'dropped' | 'closed';

/** Visual state of a report: open, or closed with its reason (`manual` and unknown reasons read « closed »). */
export function toneOf(item: Pick<IssueReportItem, 'status' | 'closedReason'>): IssueReportTone {
  if (item.status === 'open') return 'open';
  if (item.closedReason === 'fixed' || item.closedReason === 'dropped') return item.closedReason;
  return 'closed';
}
