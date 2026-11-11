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

/**
 * Budget class of a line. The front (reachable without a session for pre-login checks) gets its own share, and the
 * last part of the day's budget is kept for back violations: a flood of front or `ok` lines cannot hide a violation.
 */
export type TraceClass = 'front' | 'back' | 'violation';
/** Shares of the daily cap: front lines (their own bytes), ordinary back lines and violations (bytes of the whole file). */
export const TRACE_CLASS_SHARE: Readonly<Record<TraceClass, number>> = Object.freeze({ front: 0.25, back: 0.85, violation: 1 });

export interface TraceFileSinkOptions {
  /** Directory of the files (default: the back log directory, see {@link resolveValidationLogDir}). */
  dir: string;
  /** Size cap of one day's file, in bytes. */
  maxBytes: number;
  /** Days of files kept: older `validation-*.jsonl` files of `dir` are deleted at the first write of each day. */
  retentionDays: number;
  /** Clock (tests). */
  now: () => number;
  /** Called once with the reason when the sink gives up (the caller logs it once). */
  onFailure: (reason: string) => void;
  /** The `validation.trace.capped` line written once per class and day when that class reaches its share. */
  cappedLine: (traceClass: TraceClass, maxBytes: number) => string;
}

/** Same directory as `back-<day>.log` (template `fileLogger.ts`): `LOG_DIR`, else `<APP_DATA_DIR>/logs`, else `<cwd>/logs`. */
export function resolveValidationLogDir(env: Record<string, string | undefined> = process.env): string {
  return env.LOG_DIR?.trim() || appDataSubdir('logs', env) || path.join(process.cwd(), 'logs');
}

const OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * Appends JSON lines to the day's file: one `write` per line on an `O_APPEND` descriptor (lines of several processes do
 * not interleave, nothing is lost on a crash), opened with `O_NOFOLLOW` (a planted symbolic link is refused) and kept
 * `0600`; the directory is created `0700` with a `.gitignore` (`*`). Never throws: the first failure disables the sink
 * for the process and is reported once through `onFailure`.
 */
export class TraceFileSink {
  private day = '';
  private fd: number | null = null;
  private bytes = 0;
  private frontBytes = 0;
  private capped = new Set<TraceClass>();
  private failed = false;

  constructor(private readonly options: TraceFileSinkOptions) {}

  /** Writes one line (without its newline) of a class. Returns false when nothing was written (capped or failed). */
  write(line: string, traceClass: TraceClass = 'back'): boolean {
    if (this.failed) return false;
    try {
      this.rollDay();
      const size = Buffer.byteLength(line) + 1;
      if (this.capped.has(traceClass)) return false;
      if (!this.fits(size, traceClass)) {
        this.capped.add(traceClass);
        this.append(this.options.cappedLine(traceClass, this.options.maxBytes));
        return false;
      }
      this.append(line);
      if (traceClass === 'front') this.frontBytes += size;
      return true;
    } catch (error) {
      this.failed = true;
      this.closeFile();
      this.options.onFailure((error as NodeJS.ErrnoException)?.code ?? 'write error');
      return false;
    }
  }

  /** Front lines: their own share AND the share of ordinary back lines; `ok`/`info` back lines: 85 %; violations: 100 %. */
  private fits(size: number, traceClass: TraceClass): boolean {
    const { maxBytes } = this.options;
    const totalShare = traceClass === 'violation' ? TRACE_CLASS_SHARE.violation : TRACE_CLASS_SHARE.back;
    if (this.bytes + size > maxBytes * totalShare) return false;
    return traceClass !== 'front' || this.frontBytes + size <= maxBytes * TRACE_CLASS_SHARE.front;
  }

  private file(day: string): string {
    return path.join(this.options.dir, `validation-${day}.jsonl`);
  }

  private append(line: string): void {
    const data = Buffer.from(`${line}\n`);
    fs.writeSync(this.fd as number, data);
    this.bytes += data.length;
  }

  private closeFile(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
    this.fd = null;
  }

  private rollDay(): void {
    const day = new Date(this.options.now()).toISOString().slice(0, 10);
    if (day === this.day && this.fd !== null) return;
    this.closeFile();
    this.day = day;
    this.capped.clear();
    this.frontBytes = 0;
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    this.ensureGitignore();
    this.fd = fs.openSync(this.file(day), OPEN_FLAGS, 0o600);
    fs.fchmodSync(this.fd, 0o600);
    this.bytes = fs.fstatSync(this.fd).size;
    this.prune(day);
  }

  /** The traces never end up in git, whatever the project's `.gitignore` says. */
  private ensureGitignore(): void {
    try {
      fs.writeFileSync(path.join(this.options.dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    } catch {
      /* already there (or not writable: the project .gitignore still applies) */
    }
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
