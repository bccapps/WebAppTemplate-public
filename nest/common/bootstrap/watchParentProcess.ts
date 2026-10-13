/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Env var set by the desktop shell: pid of the shell process the back must not outlive. */
export const PARENT_PID_ENV = 'DESKTOP_PARENT_PID';

const DEFAULT_INTERVAL_MS = 2000;

export type ParentWatchOptions = {
  intervalMs?: number;
  /** Liveness probe, overridable in tests. Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
};

/** Parent pid from the environment; `undefined` when unset or not a positive integer. */
export function resolveParentPid(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env[PARENT_PID_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const pid = Number(raw);
  return pid > 0 ? pid : undefined;
}

/** True when a process with this pid exists (`EPERM` means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Calls `onGone` once when the process `pid` disappears (the desktop shell crashed or was killed). The timer is
 * unref'd so it never keeps the process alive. Returns a function that stops the watch.
 */
export function watchParentProcess(pid: number, onGone: () => void, options: ParentWatchOptions = {}): () => void {
  const isAlive = options.isAlive ?? isProcessAlive;
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    onGone();
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Wires the watch from `DESKTOP_PARENT_PID`: when the shell is gone, the back exits. No-op when the variable is unset. */
export function exitWhenParentGone(env: Record<string, string | undefined> = process.env): (() => void) | undefined {
  const pid = resolveParentPid(env);
  if (pid === undefined) return undefined;
  return watchParentProcess(pid, () => {
    console.error(`Desktop shell (pid ${pid}) is gone, exiting.`);
    process.exit(0);
  });
}
