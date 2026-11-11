/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// Notice → toast fallback paths (04 §10.4, conformance test 2): whatever the native path does, the notice is seen.
import { describe, expect, it, vi } from 'vitest';
import { showNotice, type ShowNoticeEnv } from './showNotice';
import type { NoticeSurface } from '../pure/inappDisplay';
import type { InteractionNoticeDto } from '../types/interactionTypes';

const notice = (patch: Partial<InteractionNoticeDto> = {}): InteractionNoticeDto =>
  ({ id: 'n1', type: 't', source: 's', category: 'info', priority: 'normal', title: { key: 'k.title' }, body: { raw: 'Body' }, url: '/messages/1', data: null, ticketId: null, createdAt: '', readAt: null, ...patch }) as InteractionNoticeDto;

function env(permission: () => 'granted' | 'denied' | 'default' | 'unsupported', showNative: NoticeSurface['showNative']) {
  const toasts: Array<Parameters<ShowNoticeEnv['toast']>[0]> = [];
  const navigate = vi.fn();
  const value: ShowNoticeEnv = {
    translate: (key) => `<${key}>`,
    toast: (input) => void toasts.push(input),
    navigate,
    surface: (showToast) => ({ permission, showNative, showToast }),
  };
  return { value, toasts, navigate };
}

describe('showNotice', () => {
  it.each(['default', 'denied', 'unsupported'] as const)('permission %s with the browser display ⇒ toast', async (permission) => {
    const native = vi.fn(async () => true);
    const e = env(() => permission, native);
    await showNotice(notice(), 'browser', e.value);
    expect(native).not.toHaveBeenCalled();
    expect(e.toasts).toHaveLength(1);
  });

  it('native notification not shown (no service worker, blocked) ⇒ toast', async () => {
    const e = env(() => 'granted', async () => false);
    await showNotice(notice(), 'browser', e.value);
    expect(e.toasts).toHaveLength(1);
  });

  it('native notification throwing ⇒ toast, no error', async () => {
    const e = env(() => 'granted', async () => Promise.reject(new Error('boom')));
    await expect(showNotice(notice(), 'browser', e.value)).resolves.toBeUndefined();
    expect(e.toasts).toHaveLength(1);
  });

  it('a throwing permission read ⇒ toast', async () => {
    const e = env(() => {
      throw new Error('no API');
    }, async () => true);
    await showNotice(notice(), 'browser', e.value);
    expect(e.toasts).toHaveLength(1);
  });

  it('native shown ⇒ no toast; the toast display never goes native', async () => {
    const native = vi.fn(async () => true);
    const a = env(() => 'granted', native);
    await showNotice(notice(), 'browser', a.value);
    expect(native).toHaveBeenCalledWith({ title: '<k.title>', body: 'Body', tag: 'vx-interaction:/messages/1', url: '/messages/1' });
    expect(a.toasts).toEqual([]);
    const b = env(() => 'granted', native);
    native.mockClear();
    await showNotice(notice(), 'toast', b.value);
    expect(native).not.toHaveBeenCalled();
    expect(b.toasts).toHaveLength(1);
  });

  it('the toast carries a stable id, the level of the category and an app-router open action', async () => {
    const e = env(() => 'unsupported', async () => false);
    await showNotice(notice({ category: 'approval' }), 'toast', e.value);
    const [toast] = e.toasts;
    expect(toast).toMatchObject({ id: 'vx-interaction:/messages/1', level: 'warning', title: { key: 'k.title' }, hint: { key: 'interaction.notice.openHint' } });
    toast.onOpen?.();
    expect(e.navigate).toHaveBeenCalledWith('/messages/1');
  });

  it('a foreign link is never navigated to, a notice without link has no open action', async () => {
    const e = env(() => 'unsupported', async () => false);
    await showNotice(notice({ url: 'https://evil.test/x', category: 'security' }), 'toast', e.value);
    e.toasts[0].onOpen?.();
    expect(e.navigate).not.toHaveBeenCalled();
    expect(e.toasts[0].level).toBe('error');
    await showNotice(notice({ url: null, id: 'n2' }), 'toast', e.value);
    expect(e.toasts[1].onOpen).toBeUndefined();
    expect(e.toasts[1].id).toBe('vx-interaction:n2');
  });
});
