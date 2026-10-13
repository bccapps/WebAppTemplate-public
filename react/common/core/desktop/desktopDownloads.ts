/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Name of the DOM event the desktop shell dispatches on `window` when a download ends. */
export const DESKTOP_DOWNLOAD_EVENT = 'desktop-download';

/** Flag the shell reads: when true, it skips its own fallback notification. */
export const DESKTOP_HANDLES_DOWNLOADS_FLAG = '__desktopHandlesDownloads';

export type DesktopDownload = { path: string; success: boolean };

export type DesktopDownloadToast = {
  level: 'success' | 'error';
  titleKey: string;
  textKey: string;
  textParams: string[];
};

type DownloadTarget = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

/** Validates the `detail` of a shell event; `null` when it is not a well-formed download notice. */
export function parseDesktopDownload(detail: unknown): DesktopDownload | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const { path, success } = detail as Record<string, unknown>;
  if (typeof path !== 'string' || typeof success !== 'boolean') return null;
  return { path, success };
}

/** Last segment of a file path, whatever the separator (`/` or `\`); the whole string if it has none. */
export function downloadFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** i18n keys and parameters of the notification for one finished download. */
export function toDownloadToast(download: DesktopDownload): DesktopDownloadToast {
  const name = downloadFileName(download.path);
  if (download.success) {
    return { level: 'success', titleKey: 'common.desktop.download.saved', textKey: 'common.desktop.download.savedIn', textParams: [name] };
  }
  return { level: 'error', titleKey: 'common.desktop.download.failed', textKey: 'common.desktop.download.failedFile', textParams: [name] };
}

/**
 * Subscribes to the shell's download events and marks the page as handling them (so the shell shows no
 * fallback). Returns the unsubscribe function, which also clears the flag.
 */
export function subscribeDesktopDownloads(
  target: DownloadTarget & Record<string, unknown>,
  onDownload: (download: DesktopDownload) => void,
): () => void {
  const listener = (event: Event) => {
    const download = parseDesktopDownload((event as CustomEvent).detail);
    if (download) onDownload(download);
  };
  target.addEventListener(DESKTOP_DOWNLOAD_EVENT, listener);
  target[DESKTOP_HANDLES_DOWNLOADS_FLAG] = true;
  return () => {
    target.removeEventListener(DESKTOP_DOWNLOAD_EVENT, listener);
    target[DESKTOP_HANDLES_DOWNLOADS_FLAG] = false;
  };
}
