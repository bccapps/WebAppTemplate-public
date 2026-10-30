/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface RateLimitedLogOptions {
  /** Prefix of the summary line. */
  name: string;
  /** Lines written per category and per window; the next ones are only counted. */
  perWindow: number;
  /** Window length, in ms (fixed window, starting at the first line of the category). */
  windowMs: number;
  /** Where lines go (e.g. `console.warn`). */
  write: (line: string) => void;
  /** Clock (tests). */
  now?: () => number;
}

interface CategoryWindow {
  start: number;
  written: number;
  suppressed: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Log lines a remote caller can trigger at will (bad requests): at most `perWindow` lines per category and per window,
 * then one summary line with the count of the suppressed ones, written when the window ends. Categories must come from a
 * fixed set (never from request data): one state is kept per category.
 */
export class RateLimitedLog {
  private readonly windows = new Map<string, CategoryWindow>();

  constructor(private readonly options: RateLimitedLogOptions) {}

  /** Writes `line` unless `category` already wrote its quota in the current window; returns whether it was written. */
  log(category: string, line: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    let state = this.windows.get(category);
    if (!state || now - state.start >= this.options.windowMs) {
      if (state) this.flush(category);
      state = { start: now, written: 0, suppressed: 0, timer: null };
      this.windows.set(category, state);
    }
    if (state.written < this.options.perWindow) {
      state.written += 1;
      this.options.write(line);
      return true;
    }
    state.suppressed += 1;
    if (!state.timer) {
      state.timer = setTimeout(() => this.flush(category), Math.max(0, state.start + this.options.windowMs - now));
      state.timer.unref?.();
    }
    return false;
  }

  /** Writes the summary of the suppressed lines of `category` (of every category when omitted) and resets the counts. */
  flush(category?: string): void {
    for (const [key, state] of this.windows) {
      if (category !== undefined && key !== category) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (state.suppressed === 0) continue;
      const seconds = Math.round(this.options.windowMs / 1000);
      this.options.write(
        `${this.options.name}: ${state.suppressed} more "${key}" line(s) suppressed (at most ${this.options.perWindow} per ${seconds} s)`,
      );
      state.suppressed = 0;
    }
  }
}
