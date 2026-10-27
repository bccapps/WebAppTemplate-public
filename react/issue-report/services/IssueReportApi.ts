/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { HttpResult } from '../../common/core/http/HttpResult';
import { httpService } from '../../common/core/http/HttpService';
import { configurationService } from '../../common/services/ConfigurationService';
import type { IssueReportConfig, IssueReportCreated, IssueReportDraft, IssueReportItem } from '../types';

function endpoint(path: string): string {
  return `${configurationService.getApiUrl('issue-report')}/issue-reports${path}`;
}

function promiseOf<T>(result: HttpResult): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    result.then(resolve).fail(reject).error(reject).notAuthorized(reject);
  });
}

let configPromise: Promise<IssueReportConfig> | null = null;

/** Calls of the `issue-report` back module. */
export const issueReportApi = {
  /** Cached for the page: the answer depends on the back's environment only. A failure is not cached. */
  getConfig(): Promise<IssueReportConfig> {
    if (!configPromise) {
      configPromise = promiseOf<IssueReportConfig>(httpService.get(endpoint('/config'))).catch((error: unknown) => {
        configPromise = null;
        throw error;
      });
    }
    return configPromise;
  },

  create(draft: IssueReportDraft): Promise<IssueReportCreated> {
    return promiseOf<IssueReportCreated>(httpService.post(endpoint(''), draft));
  },

  mine(): Promise<IssueReportItem[]> {
    return promiseOf<IssueReportItem[]>(httpService.get(endpoint('/mine')));
  },
};

/** Test-only: forgets the cached config. */
export function resetIssueReportConfigCache(): void {
  configPromise = null;
}
