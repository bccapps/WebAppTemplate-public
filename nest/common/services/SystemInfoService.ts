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
import { execSync } from 'child_process';
import SystemInfoDto from '../dtos/SystemInfoDto';

@Injectable()
export class SystemInfoService {
  async getSystemInfo(): Promise<SystemInfoDto> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const disk = this.getDiskUsage();

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

  private getDiskUsage(): SystemInfoDto['disk'] {
    try {
      const output = execSync('df -k /', { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      if (lines.length < 2) return this.zeroDisk();

      const parts = lines[1].split(/\s+/);
      const totalKb = parseInt(parts[1], 10);
      const usedKb = parseInt(parts[2], 10);
      const freeKb = parseInt(parts[3], 10);

      if (isNaN(totalKb) || isNaN(usedKb) || isNaN(freeKb)) return this.zeroDisk();

      const totalBytes = totalKb * 1024;
      const usedBytes = usedKb * 1024;
      const freeBytes = freeKb * 1024;

      return {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : 0,
      };
    } catch {
      return this.zeroDisk();
    }
  }

  private zeroDisk(): SystemInfoDto['disk'] {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePercent: 0 };
  }
}
