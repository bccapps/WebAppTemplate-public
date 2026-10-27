/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Answer of `POST /api/v1/issue-reports` (`201`): the hub's number of the new issue. */
export class IssueReportCreatedDto {
  number!: number;
}
