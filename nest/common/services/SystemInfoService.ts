/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SystemInfoDto from '../dtos/SystemInfoDto';
import { resolveAppDataDir } from '../utils/appDataDir';

@Injectable()
export class SystemInfoService {
  async getSystemInfo(): Promise<SystemInfoDto> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const disk = await this.getDiskUsage();

    return {
      memory: {
        totalBytes: totalMem,
        usedBytes: usedMem,
        freeBytes: freeMem,
        usagePercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 10000) / 100 : 0,
      },
      disk,
    };
  }

  /**
   * Usage of the volume holding `APP_DATA_DIR` (when set and present), else the root of the current drive.
   * `fs.statfs` (Node >= 18.15) works on Linux, macOS and Windows: no system command.
   */
  private async getDiskUsage(): Promise<SystemInfoDto['disk']> {
    const candidates = [resolveAppDataDir(), path.parse(process.cwd()).root].filter((p): p is string => !!p);
    for (const target of candidates) {
      try {
        const st = await fs.promises.statfs(target);
        const totalBytes = st.blocks * st.bsize;
        const freeBytes = st.bavail * st.bsize;
        const usedBytes = totalBytes - st.bfree * st.bsize;
        if (![totalBytes, usedBytes, freeBytes].every(Number.isFinite)) continue;
        // `df` semantics: usage = used / (used + available to unprivileged users).
        const denom = usedBytes + freeBytes;
        return {
          totalBytes,
          usedBytes,
          freeBytes,
          usagePercent: denom > 0 ? Math.round((usedBytes / denom) * 10000) / 100 : 0,
        };
      } catch {
        // try the next candidate
      }
    }
    return this.zeroDisk();
  }

  private zeroDisk(): SystemInfoDto['disk'] {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0 };
  }
}
