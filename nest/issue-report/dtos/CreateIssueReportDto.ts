/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  ISSUE_REPORT_APP_VERSION_MAX,
  ISSUE_REPORT_DESCRIPTION_MAX,
  ISSUE_REPORT_RAW_URL_MAX,
  ISSUE_REPORT_TITLE_MAX,
  ISSUE_REPORT_TITLE_MIN,
} from '../issueReportTypes';

/**
 * Body of `POST /api/v1/issue-reports`. First gate when the app runs the global `ValidationPipe`; the service
 * validates and normalizes every field again (`issueReportInput.ts`). The reporter comes from the session, never
 * from the body.
 */
export class CreateIssueReportDto {
  @IsString()
  @MinLength(ISSUE_REPORT_TITLE_MIN)
  @MaxLength(ISSUE_REPORT_TITLE_MAX)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(ISSUE_REPORT_DESCRIPTION_MAX)
  description!: string;

  /** Page of the app; query string and fragment are dropped server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(ISSUE_REPORT_RAW_URL_MAX)
  pageUrl?: string;

  /** Used only when the back has no `APP_VERSION`. */
  @IsOptional()
  @IsString()
  @MaxLength(ISSUE_REPORT_APP_VERSION_MAX)
  appVersion?: string;
}
