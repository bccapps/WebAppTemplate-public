/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from 'vitest';
import { currentPageUrl, errorMessageKey, toneOf, validateIssueReportForm } from './issueReportForm';

describe('validateIssueReportForm', () => {
  it('accepts a title of 3+ characters and a description', () => {
    expect(validateIssueReportForm('  Bug  ', 'It fails')).toEqual({});
  });

  it('marks missing, too short and too long fields', () => {
    expect(validateIssueReportForm(' ', ' ')).toEqual({
      title: { key: 'issueReport.form.error.required' },
      description: { key: 'issueReport.form.error.required' },
    });
    expect(validateIssueReportForm('ab', 'x').title).toEqual({ key: 'issueReport.form.error.tooShort', params: [3] });
    expect(validateIssueReportForm('x'.repeat(201), 'x').title).toEqual({ key: 'issueReport.form.error.tooLong', params: [200] });
    expect(validateIssueReportForm('Bug', 'x'.repeat(10_001)).description).toEqual({ key: 'issueReport.form.error.tooLong', params: [10_000] });
  });
});

describe('currentPageUrl', () => {
  it('keeps origin and path only', () => {
    expect(currentPageUrl({ origin: 'https://app.example.com', pathname: '/orders/12' })).toBe('https://app.example.com/orders/12');
  });

  it('drops an oversized page instead of sending it', () => {
    expect(currentPageUrl({ origin: 'https://app.example.com', pathname: `/${'a'.repeat(600)}` })).toBeUndefined();
  });
});

describe('errorMessageKey', () => {
  it('maps the back answers to a message', () => {
    expect(errorMessageKey({ statusCode: 400 })).toBe('issueReport.error.invalid');
    expect(errorMessageKey({ statusCode: 401 })).toBe('issueReport.error.signedOut');
    expect(errorMessageKey({ statusCode: 429 })).toBe('issueReport.error.rateLimited');
    expect(errorMessageKey({ statusCode: 503 })).toBe('issueReport.error.unavailable');
    expect(errorMessageKey({ statusCode: 502 })).toBe('issueReport.error.hubDown');
    expect(errorMessageKey(null)).toBe('issueReport.error.hubDown');
  });
});

describe('toneOf', () => {
  it('reads open, fixed, dropped, and closed for any other reason', () => {
    expect(toneOf({ status: 'open', closedReason: null })).toBe('open');
    expect(toneOf({ status: 'closed', closedReason: 'fixed' })).toBe('fixed');
    expect(toneOf({ status: 'closed', closedReason: 'dropped' })).toBe('dropped');
    expect(toneOf({ status: 'closed', closedReason: 'manual' })).toBe('closed');
    expect(toneOf({ status: 'closed', closedReason: null })).toBe('closed');
  });
});
