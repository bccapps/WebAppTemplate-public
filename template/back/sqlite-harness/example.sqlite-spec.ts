/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Minimal SQLite spec: every entity of the app synchronises on the real SQLite engine. Extend it with round trips of the entities
// and the queries that matter for the app (JSON columns, dates, the text searches written with `dbDialect()`).
// The engine is forced BEFORE the entities are imported (e2e-setup-sqlite.ts), hence the dynamic require below.
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';

describe('the app on SQLite', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: AppDataSource } = require('../src/config/Datasource') as { default: DataSource };
    dataSource = AppDataSource;
    if (!dataSource.isInitialized) await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('synchronises every entity', () => {
    expect(dataSource.entityMetadatas.length).toBeGreaterThan(0);
  });
});
