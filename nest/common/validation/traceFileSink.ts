/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as fs from 'fs';
import * as path from 'path';
import { appDataSubdir } from '../utils/appDataDir';

/** Name of a daily validation trace file: `validation-YYYY-MM-DD.jsonl` (UTC day, like `back-<day>.log`). */
export const VALIDATION_FILE_PATTERN = /^validation-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface TraceFileSinkOptions {
  /** Directory of the files (default: the back log directory, see {@link resolveValidationLogDir}). */
  dir: string;
  /** Size cap of one day's file, in bytes: past it, one `validation.trace.capped` line and nothing more that day. */
  maxBytes: number;
  /** Days of files kept: older `validation-*.jsonl` files of `dir` are deleted at the first write of each day. */
  retentionDays: number;
  /** Clock (tests). */
  now: () => number;
  /** Called once with the reason when the sink gives up (the caller logs it once). */
  onFailure: (reason: string) => void;
}

/** Same directory as `back-<day>.log` (template `fileLogger.ts`): `LOG_DIR`, else `<APP_DATA_DIR>/logs`, else `<cwd>/logs`. */
export function resolveValidationLogDir(env: Record<string, string | undefined> = process.env): string {
  return env.LOG_DIR?.trim() || appDataSubdir('logs', env) || path.join(process.cwd(), 'logs');
}

/**
 * Appends JSON lines to the day's file. Synchronous appends (one `write` per line, `O_APPEND`): no line is lost on a
 * crash and lines of several processes sharing the directory do not interleave. Files are created `0600`. Never
 * throws: the first failure disables the sink for the process and is reported once through `onFailure`.
 */
export class TraceFileSink {
  private day = '';
  private bytes = 0;
  private capped = false;
  private failed = false;

  constructor(private readonly options: TraceFileSinkOptions) {}

  /** Writes one line (without its newline). Returns false when nothing was written (capped or failed). */
  write(line: string): boolean {
    if (this.failed) return false;
    try {
      this.rollDay();
      const size = Buffer.byteLength(line) + 1;
      if (this.capped) return false;
      if (this.bytes + size > this.options.maxBytes) {
        this.capped = true;
        this.append(JSON.stringify({ ts: new Date(this.options.now()).toISOString(), check: 'validation.trace.capped', outcome: 'info', fields: { maxBytes: this.options.maxBytes } }));
        return false;
      }
      this.append(line);
      return true;
    } catch (error) {
      this.failed = true;
      this.options.onFailure((error as NodeJS.ErrnoException)?.code ?? 'write error');
      return false;
    }
  }

  private file(day: string): string {
    return path.join(this.options.dir, `validation-${day}.jsonl`);
  }

  private append(line: string): void {
    const data = `${line}\n`;
    fs.appendFileSync(this.file(this.day), data, { mode: 0o600 });
    this.bytes += Buffer.byteLength(data);
  }

  private rollDay(): void {
    const day = new Date(this.options.now()).toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.capped = false;
    fs.mkdirSync(this.options.dir, { recursive: true });
    this.bytes = fs.existsSync(this.file(day)) ? fs.statSync(this.file(day)).size : 0;
    this.capped = this.bytes >= this.options.maxBytes;
    this.prune(day);
  }

  /** Deletes the `validation-<day>.jsonl` files older than the retention (by the date in their name, nothing else). */
  private prune(today: string): void {
    const cutoff = Date.parse(`${today}T00:00:00Z`) - this.options.retentionDays * 86_400_000;
    for (const name of fs.readdirSync(this.options.dir)) {
      const match = VALIDATION_FILE_PATTERN.exec(name);
      if (!match || Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.options.dir, name));
      } catch {
        /* another process pruned it first */
      }
    }
  }
}
