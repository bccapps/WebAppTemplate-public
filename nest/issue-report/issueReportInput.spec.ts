/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import {
  IssueReportInputError,
  normalizeAppVersion,
  normalizeDescription,
  normalizeIssueReportInput,
  normalizePageUrl,
  normalizeTitle,
  normalizeUserAgent,
} from './issueReportInput';

function fieldOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof IssueReportInputError ? error.field : 'other';
  }
}

describe('normalizeIssueReportInput', () => {
  it('normalizes a valid report and ignores unknown fields (no reporter from the body)', () => {
    const input = normalizeIssueReportInput({
      title: '  The\tsave   button\nfails ',
      description: '\r\nSteps:\r\n1. click\u0007\n',
      pageUrl: 'https://app.example.com/settings/profile?token=secret#tab',
      appVersion: '1.4.2-beta+7',
      reporterRef: 'admin',
      userId: 1,
    });
    expect(input).toEqual({
      title: 'The save button fails',
      description: 'Steps:\n1. click',
      pageUrl: 'https://app.example.com/settings/profile',
      appVersion: '1.4.2-beta+7',
    });
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'x', 3, ['a']]) expect(fieldOf(() => normalizeIssueReportInput(body))).toBe('body');
  });

  it('bounds the title (3 to 200 characters after trimming, a string)', () => {
    expect(fieldOf(() => normalizeTitle('ab'))).toBe('title');
    expect(fieldOf(() => normalizeTitle('   abc   '))).toBeNull();
    expect(fieldOf(() => normalizeTitle('x'.repeat(201)))).toBe('title');
    expect(normalizeTitle('x'.repeat(200))).toHaveLength(200);
    expect(fieldOf(() => normalizeTitle(42))).toBe('title');
  });

  it('bounds the description (1 to 10 000 characters, a string)', () => {
    expect(fieldOf(() => normalizeDescription('   \n '))).toBe('description');
    expect(fieldOf(() => normalizeDescription('x'.repeat(10_001)))).toBe('description');
    expect(normalizeDescription('x'.repeat(10_000))).toHaveLength(10_000);
    expect(fieldOf(() => normalizeDescription({ text: 'x' }))).toBe('description');
  });

  it('keeps only origin and path of the page, refuses other schemes and oversized values', () => {
    expect(normalizePageUrl('/orders/12?code=abc#x')).toBe('/orders/12');
    expect(normalizePageUrl('https://user:pass@app.example.com/a?b=c')).toBe('https://app.example.com/a');
    expect(normalizePageUrl('')).toBeNull();
    expect(normalizePageUrl(undefined)).toBeNull();
    expect(fieldOf(() => normalizePageUrl('javascript:alert(1)'))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl('//evil.example.com/x'))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl('not a url'))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl(`/${'a'.repeat(600)}`))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl(`/a?${'q'.repeat(2_100)}`))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl('/a\nb'))).toBe('pageUrl');
    // the control-character check holds on every call (no regex state kept between calls)
    expect(fieldOf(() => normalizePageUrl('/a\u0001'))).toBe('pageUrl');
    expect(fieldOf(() => normalizePageUrl('/b\u0001'))).toBe('pageUrl');
  });

  it('accepts a plain version string only', () => {
    expect(normalizeAppVersion(' 2026.10.27 ')).toBe('2026.10.27');
    expect(normalizeAppVersion(null)).toBeNull();
    expect(fieldOf(() => normalizeAppVersion('1.0 <script>'))).toBe('appVersion');
    expect(fieldOf(() => normalizeAppVersion('v'.repeat(65)))).toBe('appVersion');
  });

  it('bounds the user agent header and never refuses it', () => {
    expect(normalizeUserAgent('Mozilla/5.0\r\nX: y')).toBe('Mozilla/5.0  X: y');
    expect(normalizeUserAgent('a'.repeat(400))).toHaveLength(300);
    expect(normalizeUserAgent(['first', 'second'])).toBe('first');
    expect(normalizeUserAgent(undefined)).toBeNull();
    expect(normalizeUserAgent('   ')).toBeNull();
  });
});
