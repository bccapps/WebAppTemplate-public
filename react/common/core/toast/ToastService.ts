/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createElement, type ReactNode } from 'react';
import { toast, type TypeOptions } from 'react-toastify';
import { ToastZone } from '../../components/ui/toast/ToastZone';
import { i18n } from '../i18n/I18n';

/** A text of `notice()`: a translation key with NAMED `{param}`s, or an already rendered text (shown as text, never HTML). */
export type ToastNoticeText = { key: string; params?: Record<string, string | number> } | { raw: string };

/** A clickable notice toast (`toastService.notice`). */
export interface ToastNotice {
  /** Stable per target: a repeat with the same id updates the toast on screen instead of stacking a second one. */
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: ToastNoticeText;
  body?: ToastNoticeText | null;
  /** A line under the text (« Click to open »), shown only with `onOpen`. */
  hint?: ToastNoticeText;
  /** A click on the toast runs it, then the toast closes. */
  onOpen?: () => void;
}

/** The text of a `ToastNoticeText` in the current language (`{name}` placeholders filled). */
export function toastNoticeText(text: ToastNoticeText | null | undefined): string {
  if (!text) return '';
  if ('raw' in text) return text.raw;
  const params = text.params ?? {};
  return i18n.get(text.key).replace(/\{([A-Za-z0-9_]{1,32})\}/g, (match, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

function noticeContent(input: ToastNotice): ReactNode {
  const body = toastNoticeText(input.body);
  return createElement(
    'div',
    { className: input.onOpen ? 'vx-toast-notice vx-toast-notice--clickable' : 'vx-toast-notice' },
    createElement('b', null, toastNoticeText(input.title)),
    body ? createElement('div', null, body) : null,
    input.onOpen && input.hint ? createElement('div', { className: 'vx-toast-notice-hint' }, toastNoticeText(input.hint)) : null,
  );
}

class ToastServiceImpl {
  success(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'success', options);
  }

  error(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'error', options);
  }

  warning(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'warning', options);
  }

  info(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'info', options);
  }

  /**
   * A notice on the container mounted by `ToastZone` (added for the `interaction` module, 04 §10.3): translated or raw
   * texts, a click that runs `onOpen` and closes it, and the same `id` updating the toast on screen.
   */
  notice(input: ToastNotice): void {
    const type: TypeOptions = input.level === 'info' ? 'default' : input.level;
    const options = { type, closeOnClick: Boolean(input.onOpen), onClick: input.onOpen ? () => input.onOpen?.() : undefined };
    const render = () => noticeContent(input);
    if (toast.isActive(input.id)) toast.update(input.id, { render, ...options });
    else toast(render, { toastId: input.id, ...options });
  }
}

export const toastService = new ToastServiceImpl();
