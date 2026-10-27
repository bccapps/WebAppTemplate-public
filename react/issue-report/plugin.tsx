/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AppPlugin, AppPluginFactory } from '../common/plugins/AppPlugin';
import { IssueReportButton } from './components/IssueReportButton';

export interface IssueReportPluginOptions {
  /**
   * « Report a problem » button in the header (default `true`). `false` hides it there; the app can then render
   * `<IssueReportButton />` wherever it wants.
   */
  headerAction?: boolean;
}

export const createIssueReportPlugin: AppPluginFactory<IssueReportPluginOptions> = (options) => {
  const headerAction = options?.headerAction ?? true;
  if (typeof headerAction !== 'boolean') {
    throw new Error(`Plugin "issue-report": headerAction must be a boolean (got "${String(headerAction)}")`);
  }
  return { id: 'issue-report', ...(headerAction ? { HeaderActions: IssueReportButton } : {}) } satisfies AppPlugin;
};
createIssueReportPlugin.pluginId = 'issue-report';

export const plugin = createIssueReportPlugin;
