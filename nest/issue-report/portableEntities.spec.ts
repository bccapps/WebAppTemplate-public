/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Postgres schema guard for `issue-report`: without `DB_ENGINE`, dates are `timestamptz`. Metadata only. */
import { restoreEngineEnv } from '../common/testing/postgresEngineEnv';
import { afterAll, describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';
import { IssueReportEntity } from './entities/IssueReportEntity';

describe('issue-report entity keeps its Postgres column types', () => {
  afterAll(restoreEngineEnv);
  const dataSource = new DataSource({ type: 'postgres', entities: [IssueReportEntity] });
  (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

  it('IssueReportEntity', () => {
    const metadata = dataSource.getMetadata(IssueReportEntity);
    expect(metadata.tableName).toBe('issue_report');
    for (const property of ['closedAt', 'notifiedAt', 'createdAt']) {
      expect(metadata.findColumnWithPropertyName(property)?.type).toBe('timestamptz');
    }
    expect(metadata.findColumnWithPropertyName('userId')?.length).toBe('64');
    expect(metadata.findColumnWithPropertyName('closedReason')?.isNullable).toBe(true);
  });
});
