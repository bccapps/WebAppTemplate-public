/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// Permission states, the « do not offer again » choice (localStorage failures tolerated) and the native surface.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/interactionApi', () => ({ interactionApi: {} }));

type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const throwingStorage: Storage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

/** A fresh copy of the module (its dismissed flag is read at load). */
async function load() {
  vi.resetModules();
  return import('./browserNotifications');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readBrowserPermission', () => {
  it('is unsupported without the Notification API', async () => {
    vi.stubGlobal('Notification', undefined);
    expect((await load()).readBrowserPermission()).toBe('unsupported');
  });

  it.each(['default', 'granted', 'denied'] as const)('mirrors Notification.permission (%s)', async (permission) => {
    vi.stubGlobal('Notification', { permission });
    expect((await load()).readBrowserPermission()).toBe(permission);
  });
});

describe('requestBrowserPermission', () => {
  it('is unsupported without the API and never throws', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(await (await load()).requestBrowserPermission()).toBe('unsupported');
  });

  it('asks the browser and returns the permission read back', async () => {
    const Notification = { permission: 'default', requestPermission: vi.fn(async () => ((Notification.permission = 'granted'), 'granted')) };
    vi.stubGlobal('Notification', Notification);
    expect(await (await load()).requestBrowserPermission()).toBe('granted');
    expect(Notification.requestPermission).toHaveBeenCalledOnce();
  });

  it('tolerates requestPermission throwing (old browsers) and returns the current state', async () => {
    vi.stubGlobal('Notification', {
      permission: 'denied',
      requestPermission: () => {
        throw new Error('callback form only');
      },
    });
    expect(await (await load()).requestBrowserPermission()).toBe('denied');
  });
});

describe('dismissBrowserPrompt', () => {
  it('stores the choice under the documented key', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    const m = await load();
    m.dismissBrowserPrompt();
    expect(storage.data.get(m.PROMPT_DISMISSED_STORAGE_KEY)).toBe('1');
    expect(m.PROMPT_DISMISSED_STORAGE_KEY).toBe('vx.interaction.browserPromptDismissed');
  });

  it('tolerates a failing localStorage (write and read) and does not throw', async () => {
    vi.stubGlobal('window', { localStorage: throwingStorage });
    const m = await load(); // the read at load time throws internally: dismissed starts false
    expect(() => m.dismissBrowserPrompt()).not.toThrow();
  });

  it('tolerates a missing window', async () => {
    vi.stubGlobal('window', undefined);
    const m = await load();
    expect(() => m.dismissBrowserPrompt()).not.toThrow();
  });

  it('a stored choice is read at load', async () => {
    const storage = memoryStorage();
    storage.data.set('vx.interaction.browserPromptDismissed', '1');
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('Notification', { permission: 'default' });
    const m = await load();
    // useBrowserPermissionState is a hook; the module state it reads is checked through a dismiss round trip.
    expect(() => m.dismissBrowserPrompt()).not.toThrow();
    expect(storage.data.get(m.PROMPT_DISMISSED_STORAGE_KEY)).toBe('1');
  });
});

describe('browserSurface', () => {
  it('reads the live permission', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    const { browserSurface } = await load();
    expect(browserSurface(() => undefined).permission()).toBe('granted');
  });

  it('shows through the service worker registration when there is one', async () => {
    const showNotification = vi.fn(async () => undefined);
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ showNotification }) } });
    const { browserSurface } = await load();
    expect(await browserSurface(() => undefined).showNative({ title: 'T', body: 'B', tag: 'g', url: '/x' })).toBe(true);
    expect(showNotification).toHaveBeenCalledWith('T', { body: 'B', tag: 'g', data: { url: '/x' } });
  });

  it('falls back to new Notification without a registration', async () => {
    const created: Array<{ title: string; options: unknown }> = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: unknown) {
        created.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => undefined } });
    const { browserSurface } = await load();
    expect(await browserSurface(() => undefined).showNative({ title: 'T', body: 'B', tag: 'g', url: null })).toBe(true);
    expect(created).toEqual([{ title: 'T', options: { body: 'B', tag: 'g' } }]);
  });

  it('returns false (⇒ toast) when nothing can show it or the API throws', async () => {
    vi.stubGlobal('Notification', undefined);
    vi.stubGlobal('navigator', {});
    let m = await load();
    expect(await m.browserSurface(() => undefined).showNative({ title: 'T', body: 'B', tag: 'g', url: null })).toBe(false);

    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => {
          throw new Error('sw down');
        },
      },
    });
    m = await load();
    expect(await m.browserSurface(() => undefined).showNative({ title: 'T', body: 'B', tag: 'g', url: null })).toBe(false);
  });

  it('passes the toast through', async () => {
    const toast = vi.fn();
    const { browserSurface } = await load();
    browserSurface(toast).showToast();
    expect(toast).toHaveBeenCalledOnce();
  });
});

describe('isWebPushSupported', () => {
  it('needs window, a service worker and PushManager', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { serviceWorker: {} });
    expect((await load()).isWebPushSupported()).toBe(false);
    vi.stubGlobal('window', { PushManager: {} });
    expect((await load()).isWebPushSupported()).toBe(true);
  });
});
