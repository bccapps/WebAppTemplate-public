/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import * as os from 'os';
import { SystemInfoService } from './SystemInfoService';

describe('SystemInfoService', () => {
  const saved = process.env.APP_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = saved;
  });

  it('reports disk usage without any system command', async () => {
    delete process.env.APP_DATA_DIR;
    const { disk } = await new SystemInfoService().getSystemInfo();
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.usagePercent).toBeGreaterThanOrEqual(0);
    expect(disk.usagePercent).toBeLessThanOrEqual(100);
  });

  it('measures APP_DATA_DIR when it exists, falls back when it does not', async () => {
    process.env.APP_DATA_DIR = os.tmpdir();
    expect((await new SystemInfoService().getSystemInfo()).disk.totalBytes).toBeGreaterThan(0);
    process.env.APP_DATA_DIR = '/nonexistent/dir/for/test';
    expect((await new SystemInfoService().getSystemInfo()).disk.totalBytes).toBeGreaterThan(0);
  });
});
