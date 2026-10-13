/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** The part of `File` the filter needs (lets it run on plain objects). */
export interface FileLike {
  name: string;
  type: string;
  size: number;
}

export type RejectionReason = 'type' | 'size' | 'count';

export interface FileRejection<T extends FileLike = File> {
  file: T;
  reason: RejectionReason;
}

export interface FileFilterOptions {
  /**
   * Comma-separated list, like the HTML `accept` attribute: extensions (`.pdf`), exact MIME types (`audio/wav`) and
   * wildcards (`image/*`). Empty or omitted accepts everything.
   */
  accept?: string;
  /** Several files at once. When false, only the first acceptable file is kept (the others are rejected as `count`). */
  multiple?: boolean;
  maxSizeBytes?: number;
}

export function parseAccept(accept: string | undefined): string[] {
  return (accept ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the file matches one of the `accept` patterns (everything matches an empty list). */
export function matchesAccept(file: FileLike, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

/** Splits dropped files into accepted and rejected (with the reason), preserving order. */
export function filterFiles<T extends FileLike>(
  files: readonly T[],
  options: FileFilterOptions = {},
): { accepted: T[]; rejected: FileRejection<T>[] } {
  const patterns = parseAccept(options.accept);
  const accepted: T[] = [];
  const rejected: FileRejection<T>[] = [];
  for (const file of files) {
    if (!matchesAccept(file, patterns)) rejected.push({ file, reason: 'type' });
    else if (options.maxSizeBytes !== undefined && file.size > options.maxSizeBytes) rejected.push({ file, reason: 'size' });
    else if (!options.multiple && accepted.length >= 1) rejected.push({ file, reason: 'count' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** True when a drag carries files (and not text or a link dragged inside the page). */
export function dragHasFiles(types: readonly string[] | undefined): boolean {
  return !!types && Array.from(types).includes('Files');
}

/**
 * Counts `dragenter`/`dragleave` pairs: they fire for every child element crossed, so a plain boolean flickers.
 * `enter` returns true on the first entry, `leave` returns true when the pointer really left, `reset` on drop.
 */
export function createDragCounter() {
  let depth = 0;
  return {
    enter(): boolean {
      depth += 1;
      return depth === 1;
    },
    leave(): boolean {
      depth = Math.max(0, depth - 1);
      return depth === 0;
    },
    reset(): void {
      depth = 0;
    },
  };
}
