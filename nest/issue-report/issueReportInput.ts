/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  ISSUE_REPORT_APP_VERSION_MAX,
  ISSUE_REPORT_DESCRIPTION_MAX,
  ISSUE_REPORT_PAGE_URL_MAX,
  ISSUE_REPORT_RAW_URL_MAX,
  ISSUE_REPORT_TITLE_MAX,
  ISSUE_REPORT_TITLE_MIN,
  ISSUE_REPORT_USER_AGENT_MAX,
} from './issueReportTypes';

/**
 * Server-side validation of a report, independent of the app's `ValidationPipe` (an app may run without one, or in
 * validate-only mode): every field is checked and normalized here before anything leaves the server.
 */

export type IssueReportField = 'body' | 'title' | 'description' | 'pageUrl' | 'appVersion';

export class IssueReportInputError extends Error {
  constructor(readonly field: IssueReportField) {
    super(`Invalid issue report field: ${field}`);
    this.name = 'IssueReportInputError';
  }
}

export interface IssueReportInput {
  title: string;
  description: string;
  pageUrl: string | null;
  appVersion: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001F\u007F]/g;
/** Not global: `test()` on a global regex keeps its `lastIndex` between calls. */
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001F\u007F]/;
const APP_VERSION_PATTERN = /^[\w.+-]+$/;

function optionalString(value: unknown, field: IssueReportField): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new IssueReportInputError(field);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One line: control characters and runs of blanks become one space. */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') throw new IssueReportInputError('title');
  const title = value.replace(ANY_CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (title.length < ISSUE_REPORT_TITLE_MIN || title.length > ISSUE_REPORT_TITLE_MAX) throw new IssueReportInputError('title');
  return title;
}

/** Multi-line text: CRLF becomes LF, control characters other than tab and newline are dropped. */
export function normalizeDescription(value: unknown): string {
  if (typeof value !== 'string') throw new IssueReportInputError('description');
  const description = value.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINES, '').trim();
  if (description.length < 1 || description.length > ISSUE_REPORT_DESCRIPTION_MAX) throw new IssueReportInputError('description');
  return description;
}

/**
 * Page of the app the report was made from: an absolute `http(s)` URL or a path. Query string, fragment and
 * credentials are dropped (they may carry a token, a reset code or an e-mail address).
 */
export function normalizePageUrl(value: unknown): string | null {
  const raw = optionalString(value, 'pageUrl');
  if (raw === null) return null;
  if (raw.length > ISSUE_REPORT_RAW_URL_MAX || HAS_CONTROL.test(raw)) throw new IssueReportInputError('pageUrl');
  let page: string;
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    page = raw.split(/[?#]/, 1)[0];
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new IssueReportInputError('pageUrl');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new IssueReportInputError('pageUrl');
    page = `${url.origin}${url.pathname}`;
  }
  if (page.length > ISSUE_REPORT_PAGE_URL_MAX) throw new IssueReportInputError('pageUrl');
  return page;
}

export function normalizeAppVersion(value: unknown): string | null {
  const version = optionalString(value, 'appVersion');
  if (version === null) return null;
  if (version.length > ISSUE_REPORT_APP_VERSION_MAX || !APP_VERSION_PATTERN.test(version)) throw new IssueReportInputError('appVersion');
  return version;
}

/** Validates the body of `POST /api/v1/issue-reports`; unknown fields are ignored. */
export function normalizeIssueReportInput(body: unknown): IssueReportInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IssueReportInputError('body');
  const fields = body as Record<string, unknown>;
  return {
    title: normalizeTitle(fields.title),
    description: normalizeDescription(fields.description),
    pageUrl: normalizePageUrl(fields.pageUrl),
    appVersion: normalizeAppVersion(fields.appVersion),
  };
}

/** `User-Agent` header of the request, bounded; `null` when absent. Never refused: it is a header, not user input. */
export function normalizeUserAgent(value: unknown): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== 'string') return null;
  const agent = header.replace(ANY_CONTROL, ' ').trim().slice(0, ISSUE_REPORT_USER_AGENT_MAX);
  return agent.length > 0 ? agent : null;
}
