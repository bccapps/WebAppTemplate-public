/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { join } from 'path';
import { appDataSubdir, resolveAppDataDir } from './appDataDir';

describe('appDataDir', () => {
  it('is undefined when unset or blank', () => {
    expect(resolveAppDataDir({})).toBeUndefined();
    expect(resolveAppDataDir({ APP_DATA_DIR: '  ' })).toBeUndefined();
    expect(appDataSubdir('logs', {})).toBeUndefined();
  });

  it('returns the trimmed root and its subfolders', () => {
    expect(resolveAppDataDir({ APP_DATA_DIR: ' /data/app ' })).toBe('/data/app');
    expect(appDataSubdir('shared', { APP_DATA_DIR: '/data/app' })).toBe(join('/data/app', 'shared'));
  });
});
