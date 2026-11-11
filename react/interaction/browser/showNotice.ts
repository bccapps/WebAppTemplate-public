/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// One notice as a toast or a native notification (04 §10.4); the environment is injected (the host wires the real
// i18n, ToastService, router and browser surface), so the fallback paths are tested without a DOM.

import type { ToastNotice } from '../../common/core/toast/ToastService';
import { displayNotice, notificationTag, type NoticeSurface } from '../pure/inappDisplay';
import { openAppPath, type Navigate } from '../pure/navigation';
import { renderText } from '../pure/text';
import type { InappDisplay, InteractionNoticeDto } from '../types/interactionTypes';

const LEVEL: Record<string, ToastNotice['level']> = { info: 'info', approval: 'warning', security: 'error' };

export interface ShowNoticeEnv {
  translate(key: string): string;
  toast(notice: ToastNotice): void;
  navigate: Navigate;
  /** The browser side, given the toast to fall back to. */
  surface(showToast: () => void): NoticeSurface;
}

/** Shows one notice: any failure of the native path falls back to the toast (invariant 1). Never throws. */
export async function showNotice(notice: InteractionNoticeDto, wanted: InappDisplay, env: ShowNoticeEnv): Promise<void> {
  const title = renderText(notice.title, env.translate);
  const body = renderText(notice.body, env.translate);
  const tag = notificationTag(notice);
  const toast = () =>
    env.toast({
      id: tag,
      level: LEVEL[notice.category] ?? 'info',
      title: notice.title,
      body: notice.body,
      hint: { key: 'interaction.notice.openHint' },
      onOpen: notice.url ? () => void openAppPath(notice.url, env.navigate) : undefined,
    });
  await displayNotice(wanted, { title, body, tag, url: notice.url }, env.surface(toast));
}
