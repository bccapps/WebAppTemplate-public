/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

function unitFormat(locale: string, unit: string, maximumFractionDigits: number, minimumIntegerDigits = 1): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits, minimumIntegerDigits });
}

/** Index of the largest binary unit (1024) such that the value is at least 1 of it. */
function byteUnitIndex(bytes: number): number {
  let index = 0;
  let value = Math.abs(bytes);
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index;
}

function scaled(bytes: number): { value: number; index: number } {
  const index = byteUnitIndex(bytes);
  return { value: bytes / 1024 ** index, index };
}

/** "1,5 Go" / "1.5 GB": binary multiples (1024), localized unit, one decimal below 100. */
export function formatBytes(bytes: number, locale: string): string {
  const { value, index } = scaled(Math.max(0, bytes));
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return unitFormat(locale, BYTE_UNITS[index], digits).format(value);
}

/** "12 Mo/s" / "12 MB/s". */
export function formatRate(bytesPerSecond: number, locale: string): string {
  const { value, index } = scaled(Math.max(0, bytesPerSecond));
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return unitFormat(locale, `${BYTE_UNITS[index]}-per-second`, digits).format(value);
}

/** "42 s", "3 min 05 s", "1 h 05 min" (localized units); "—" when unknown or infinite. */
export function formatDuration(seconds: number | null | undefined, locale: string): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${unitFormat(locale, 'hour', 0).format(hours)} ${unitFormat(locale, 'minute', 0, 2).format(minutes)}`;
  if (minutes > 0) return `${unitFormat(locale, 'minute', 0).format(minutes)} ${unitFormat(locale, 'second', 0, 2).format(secs)}`;
  return unitFormat(locale, 'second', 0).format(secs);
}

/** Elapsed-time clock: "0:07", "12:03", "1:02:03". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secs}`;
  return `${minutes}:${secs}`;
}

/** Completion percentage clamped to 0-100, or null while the total is unknown (0 or negative). */
export function computePercent(done: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

/** Remaining seconds from the current rate; the given `eta` wins, null when it cannot be estimated. */
export function estimateRemaining(done: number, total: number, rate?: number, eta?: number | null): number | null {
  if (eta != null) return eta;
  if (!rate || rate <= 0 || !(total > 0)) return null;
  return Math.max(0, (total - done) / rate);
}
