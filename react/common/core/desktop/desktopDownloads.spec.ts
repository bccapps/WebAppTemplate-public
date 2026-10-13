/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_DOWNLOAD_EVENT,
  DESKTOP_HANDLES_DOWNLOADS_FLAG,
  downloadFileName,
  parseDesktopDownload,
  subscribeDesktopDownloads,
  toDownloadToast,
} from './desktopDownloads';

type Listener = (event: Event) => void;
type FakeTarget = {
  listeners: Map<string, Listener>;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string): void;
  [key: string]: unknown;
};

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    addEventListener: (type, fn) => void listeners.set(type, fn),
    removeEventListener: (type) => void listeners.delete(type),
  };
}

describe('parseDesktopDownload', () => {
  it('accepts a well-formed detail', () => {
    expect(parseDesktopDownload({ path: '/a/b.png', success: true })).toEqual({ path: '/a/b.png', success: true });
  });
  it('rejects malformed details', () => {
    for (const bad of [null, undefined, 'x', {}, { path: 1, success: true }, { path: 'a', success: 'yes' }]) {
      expect(parseDesktopDownload(bad)).toBeNull();
    }
  });
});

describe('downloadFileName', () => {
  it('handles both separators and bare names', () => {
    expect(downloadFileName('/Users/me/Downloads/a.png')).toBe('a.png');
    expect(downloadFileName('C:\\Users\\me\\a.png')).toBe('a.png');
    expect(downloadFileName('a.png')).toBe('a.png');
  });
});

describe('toDownloadToast', () => {
  it('maps success and failure to distinct keys with the file name', () => {
    expect(toDownloadToast({ path: '/x/a.png', success: true })).toEqual({
      level: 'success', titleKey: 'common.desktop.download.saved', textKey: 'common.desktop.download.savedIn', textParams: ['a.png'],
    });
    const failed = toDownloadToast({ path: '/x/a.png', success: false });
    expect(failed.level).toBe('error');
    expect(failed.textParams).toEqual(['a.png']);
  });
});

describe('subscribeDesktopDownloads', () => {
  it('forwards valid events, ignores invalid ones, and cleans up', () => {
    const target = fakeTarget();
    const onDownload = vi.fn();
    const off = subscribeDesktopDownloads(target, onDownload);
    expect(target[DESKTOP_HANDLES_DOWNLOADS_FLAG]).toBe(true);

    const fire = target.listeners.get(DESKTOP_DOWNLOAD_EVENT)!;
    fire({ detail: { path: '/x/a.png', success: true } } as unknown as Event);
    fire({ detail: 42 } as unknown as Event);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith({ path: '/x/a.png', success: true });

    off();
    expect(target.listeners.has(DESKTOP_DOWNLOAD_EVENT)).toBe(false);
    expect(target[DESKTOP_HANDLES_DOWNLOADS_FLAG]).toBe(false);
  });
});
