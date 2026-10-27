/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { parseDbDate, parseDbDateOrNull } from '../../common/utils/dbDate';
import type { IssueReportDto } from '../dtos/IssueReportDto';
import type { IssueReportEntity } from '../entities/IssueReportEntity';

/** Entity → reporter view. `userId` and `notifiedAt` stay server-side. */
export function toIssueReportDto(entity: IssueReportEntity): IssueReportDto {
  return {
    id: entity.id,
    number: entity.hubNumber,
    title: entity.title,
    status: entity.status,
    closedReason: entity.closedReason ?? null,
    closedAt: parseDbDateOrNull(entity.closedAt)?.toISOString() ?? null,
    createdAt: parseDbDate(entity.createdAt).toISOString(),
  };
}
