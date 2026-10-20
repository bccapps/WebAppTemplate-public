/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Zero-dependency file logging.
 *
 * The app previously logged only to stdout (nest start / docker), so failures left
 * no durable trace. This tees every console.{log,info,warn,error,debug} to a daily
 * file under LOG_DIR (default ./logs/back-YYYY-MM-DD.log) with size-based rotation,
 * while preserving the existing ISO-timestamp prefix on stdout.
 *
 * Env:
 *   LOG_TO_FILE   "false" to disable file output (stdout prefix still applied). Default on.
 *   LOG_DIR       directory for log files. Default <APP_DATA_DIR>/logs, else <cwd>/logs.
 *   LOG_MAX_BYTES rotate the current day's file once it exceeds this size. Default 50MB.
 */
import * as fs from 'fs';
import * as path from 'path';

export function installFileLogging(): void {
  const ts = () => new Date().toISOString();
  const fileEnabled = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';

  let write: (line: string) => void = () => {};

  if (fileEnabled) {
    const dir = process.env.LOG_DIR || path.join(process.env.APP_DATA_DIR?.trim() || process.cwd(), 'logs');
    const maxBytes = Number(process.env.LOG_MAX_BYTES || 50 * 1024 * 1024);
    let stream: fs.WriteStream | null = null;
    let curDay = '';

    const dayStr = () => new Date().toISOString().slice(0, 10);
    const fileFor = (day: string) => path.join(dir, `back-${day}.log`);

    const rotateIfNeeded = () => {
      const day = dayStr();
      if (day !== curDay || !stream) {
        if (stream) { try { stream.end(); } catch { /* ignore */ } }
        curDay = day;
        stream = fs.createWriteStream(fileFor(day), { flags: 'a' });
        return;
      }
      try {
        const f = fileFor(day);
        if (fs.existsSync(f) && fs.statSync(f).size > maxBytes) {
          stream.end();
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.renameSync(f, path.join(dir, `back-${day}-${stamp}.log`));
          stream = fs.createWriteStream(f, { flags: 'a' });
        }
      } catch { /* ignore rotation errors */ }
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      write = (line: string) => {
        try { rotateIfNeeded(); stream?.write(line + '\n'); } catch { /* never throw from logging */ }
      };
    } catch {
      // Could not create the log dir — fall back to stdout-only.
      write = () => {};
    }
  }

  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');

  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const stamp = ts();
      orig(`[${stamp}]`, ...args);
      write(`[${stamp}] [${level.toUpperCase()}] ${fmt(args)}`);
    };
  });
}
