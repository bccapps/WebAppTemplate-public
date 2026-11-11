/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Web Push handlers of the app's service worker (04 §10.5, extracted from AgentHub `front/src/sw.ts`). The app's `sw.ts`
// (PWA) calls `installInteractionPushHandlers(self)`. A push shows a notification (title, body, tag: a repeat replaces
// it); a click focuses a tab of the app and navigates it to the notice's link (same-origin path only), else opens one.
// No DOM types here: the worker scope is described by the minimal interfaces below.

import { safeAppPath } from '../pure/text';

interface PushPayload {
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
}

interface WaitableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerClient {
  url: string;
  focus?: () => Promise<unknown>;
  navigate?: (url: string) => Promise<unknown>;
}

/** The part of `ServiceWorkerGlobalScope` the handlers use. */
export interface InteractionWorkerScope {
  location: { origin: string };
  registration: { showNotification(title: string, options: { body: string; tag?: string; data: { url: string } }): Promise<void> };
  clients: { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WorkerClient[]>; openWindow(url: string): Promise<unknown> };
  addEventListener(type: 'push', listener: (event: WaitableEvent & { data?: { json(): unknown } | null }) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: WaitableEvent & { notification: { close(): void; data?: { url?: unknown } } }) => void): void;
}

/** The payload sent by `nest/interaction` (`{ title, body, url, tag, id }`), bounded; anything else → a generic text. */
export function parsePushPayload(raw: unknown, fallbackTitle: string): PushPayload {
  const data = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    title: text(data.title, 120) || fallbackTitle,
    body: text(data.body, 1000),
    url: typeof data.url === 'string' ? data.url : null,
    tag: typeof data.tag === 'string' ? data.tag.slice(0, 200) : null,
  };
}

/** Installs the `push` and `notificationclick` handlers on the worker scope. */
export function installInteractionPushHandlers(scope: InteractionWorkerScope, options: { fallbackTitle?: string } = {}): void {
  const fallbackTitle = options.fallbackTitle ?? 'Notification';
  scope.addEventListener('push', (event) => {
    let raw: unknown;
    try {
      raw = event.data ? event.data.json() : null;
    } catch {
      raw = null;
    }
    const payload = parsePushPayload(raw, fallbackTitle);
    const path = safeAppPath(payload.url, scope.location.origin);
    event.waitUntil(scope.registration.showNotification(payload.title, { body: payload.body, ...(payload.tag ? { tag: payload.tag } : {}), data: { url: path } }));
  });
  scope.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const path = safeAppPath(event.notification.data?.url, scope.location.origin);
    event.waitUntil(openOrFocus(scope, path));
  });
}

async function openOrFocus(scope: InteractionWorkerScope, path: string): Promise<void> {
  const target = new URL(path, scope.location.origin).toString();
  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((client) => client.url.startsWith(scope.location.origin));
  if (mine?.focus) {
    await mine.focus();
    if (mine.navigate) await mine.navigate(target).catch(() => undefined);
    return;
  }
  await scope.clients.openWindow(target);
}
