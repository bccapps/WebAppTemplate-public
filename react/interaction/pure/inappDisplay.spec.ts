/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Conformance test 2 (04 §17): permission denied, default, unsupported, no service worker ⇒ toast, no visible error. */
import { describe, expect, it } from 'vitest';
import { decideInappDisplay, displayNotice, notificationTag, shouldPromptForPermission, type BrowserPermission, type NoticeSurface } from './inappDisplay';

const input = { title: 'T', body: 'B', tag: 'vx-interaction:/x', url: '/x' };

function surface(permission: BrowserPermission | (() => BrowserPermission), native: () => Promise<boolean>): NoticeSurface & { toasts: number; natives: number } {
  const state = { toasts: 0, natives: 0 };
  return Object.assign(state, {
    permission: typeof permission === 'function' ? permission : () => permission,
    showNative: async () => {
      state.natives += 1;
      return native();
    },
    showToast: () => {
      state.toasts += 1;
    },
  });
}

describe('decideInappDisplay', () => {
  it('is native only for the browser display with a granted permission', () => {
    expect(decideInappDisplay('browser', 'granted')).toBe('native');
    for (const permission of ['default', 'denied', 'unsupported'] as BrowserPermission[]) expect(decideInappDisplay('browser', permission)).toBe('toast');
    for (const wanted of ['toast', null, undefined] as const) expect(decideInappDisplay(wanted, 'granted')).toBe('toast');
  });
});

describe('displayNotice (test 2)', () => {
  it.each(['default', 'denied', 'unsupported'] as BrowserPermission[])('permission %s ⇒ toast, never the native API', async (permission) => {
    const s = surface(permission, async () => true);
    await expect(displayNotice('browser', input, s)).resolves.toBe('toast');
    expect([s.toasts, s.natives]).toEqual([1, 0]);
  });

  it('no service worker / native display refused ⇒ toast', async () => {
    const s = surface('granted', async () => false);
    await expect(displayNotice('browser', input, s)).resolves.toBe('toast');
    expect([s.toasts, s.natives]).toEqual([1, 1]);
  });

  it('a native display that throws, or a permission read that throws ⇒ toast, no error', async () => {
    const throwing = surface('granted', async () => {
      throw new Error('blocked');
    });
    await expect(displayNotice('browser', input, throwing)).resolves.toBe('toast');
    const unreadable = surface(() => {
      throw new Error('no API');
    }, async () => true);
    await expect(displayNotice('browser', input, unreadable)).resolves.toBe('toast');
    expect(unreadable.natives).toBe(0);
  });

  it('granted and shown ⇒ native, no toast', async () => {
    const s = surface('granted', async () => true);
    await expect(displayNotice('browser', input, s)).resolves.toBe('native');
    expect([s.toasts, s.natives]).toEqual([0, 1]);
  });

  it('the toast display never asks the browser', async () => {
    const s = surface('granted', async () => true);
    await expect(displayNotice('toast', input, s)).resolves.toBe('toast');
    expect(s.natives).toBe(0);
  });
});

describe('tags and prompt', () => {
  it('tags by target, prompts only while the browser can still ask', () => {
    expect(notificationTag({ id: 'a', url: '/p' })).toBe('vx-interaction:/p');
    expect(notificationTag({ id: 'a', url: null })).toBe('vx-interaction:a');
    expect(shouldPromptForPermission('browser', 'default', false)).toBe(true);
    expect(shouldPromptForPermission('browser', 'default', true)).toBe(false);
    expect(shouldPromptForPermission('browser', 'denied', false)).toBe(false);
    expect(shouldPromptForPermission('toast', 'default', false)).toBe(false);
  });
});
