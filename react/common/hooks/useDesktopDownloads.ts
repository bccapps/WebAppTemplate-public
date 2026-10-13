/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect } from 'react';
import { toastService } from '../core/toast/ToastService';
import { subscribeDesktopDownloads, toDownloadToast, type DesktopDownload } from '../core/desktop/desktopDownloads';

function notify(download: DesktopDownload): void {
  const toast = toDownloadToast(download);
  toastService[toast.level](toast.titleKey, toast.textKey, { textParams: toast.textParams });
}

/**
 * Desktop shell only: shows a toast when the shell reports a finished download (`desktop-download` event).
 * Mount it once, in the app layout. Harmless in a browser (the event is never fired). While mounted it tells
 * the shell not to show its own fallback notification. See `core/desktop/desktopDownloads.ts` for the contract.
 */
export function useDesktopDownloads(onDownload: (download: DesktopDownload) => void = notify): void {
  useEffect(() => subscribeDesktopDownloads(window as unknown as Window & Record<string, unknown>, onDownload), [onDownload]);
}
