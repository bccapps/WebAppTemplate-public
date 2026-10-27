/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./components/IssueReportButton', () => ({ IssueReportButton: () => null }));

import { collectPlugins } from '../common/plugins/AppPlugin';
import { IssueReportButton } from './components/IssueReportButton';
import { createIssueReportPlugin, plugin } from './plugin';

describe('issue-report plugin', () => {
  it('puts the report button in the header by default, without routes', () => {
    const built = createIssueReportPlugin(undefined);
    expect(built.id).toBe('issue-report');
    expect(built.HeaderActions).toBe(IssueReportButton);
    expect(built.routes).toBeUndefined();
  });

  it('hides the header button with headerAction: false', () => {
    expect(createIssueReportPlugin({ headerAction: false }).HeaderActions).toBeUndefined();
  });

  it('refuses a headerAction that is not a boolean', () => {
    expect(() => createIssueReportPlugin({ headerAction: 'no' as unknown as boolean })).toThrow(/headerAction must be a boolean/);
  });

  it('is collected under its id with the app options', () => {
    const [collected] = collectPlugins({ './modules_shared/issue-report/plugin.tsx': { plugin } }, { 'issue-report': { headerAction: false } });
    expect(collected.id).toBe('issue-report');
    expect(collected.HeaderActions).toBeUndefined();
  });
});
