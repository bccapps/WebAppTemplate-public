/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from 'vitest';
import { installInteractionPushHandlers, parsePushPayload, type InteractionWorkerScope } from './interactionPush';

type Listener = (event: never) => void;

function fakeScope(clients: Array<{ url: string; focused: number; navigated: string[] }>) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: unknown }> = [];
  const opened: string[] = [];
  const scope = {
    location: { origin: 'https://app.test' },
    registration: { showNotification: async (title: string, options: unknown) => void shown.push({ title, options }) },
    clients: {
      matchAll: async () => clients.map((client) => ({ url: client.url, focus: async () => void (client.focused += 1), navigate: async (url: string) => void client.navigated.push(url) })),
      openWindow: async (url: string) => void opened.push(url),
    },
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
  } as unknown as InteractionWorkerScope;
  installInteractionPushHandlers(scope, { fallbackTitle: 'App' });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    (listeners.get(type) as (e: unknown) => void)({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
  };
  return { fire, shown, opened };
}

describe('service worker push handlers', () => {
  it('shows the notification with its tag and a same-origin path only', async () => {
    const { fire, shown } = fakeScope([]);
    await fire('push', { data: { json: () => ({ title: 'Hi', body: 'There', url: 'https://evil.test/x', tag: 'vx-interaction:/a' }) } });
    await fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(shown).toEqual([
      { title: 'Hi', options: { body: 'There', tag: 'vx-interaction:/a', data: { url: '/' } } },
      { title: 'App', options: { body: '', data: { url: '/' } } },
    ]);
  });

  it('a click focuses a tab of the app and navigates it, else opens a window', async () => {
    const tab = { url: 'https://app.test/home', focused: 0, navigated: [] as string[] };
    const withTab = fakeScope([tab]);
    await withTab.fire('notificationclick', { notification: { close: () => undefined, data: { url: '/interaction?x=1' } } });
    expect([tab.focused, tab.navigated]).toEqual([1, ['https://app.test/interaction?x=1']]);
    const empty = fakeScope([{ url: 'https://other.test/', focused: 0, navigated: [] }]);
    await empty.fire('notificationclick', { notification: { close: () => undefined, data: { url: 'https://evil.test/' } } });
    expect(empty.opened).toEqual(['https://app.test/']);
  });

  it('bounds the payload', () => {
    expect(parsePushPayload({ title: 'x'.repeat(500), body: 3 }, 'F')).toEqual({ title: 'x'.repeat(120), body: '', url: null, tag: null });
    expect(parsePushPayload(null, 'F').title).toBe('F');
  });
});
