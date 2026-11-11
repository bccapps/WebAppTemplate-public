/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Browser side of the in-app display (extracted from AgentHub `notifications/browserNotificationStore.ts` and
// `webPush.ts`): the live permission, the « do not offer again » choice (localStorage, every access guarded), the
// native notification of a notice, and the Web Push subscription. The permission is asked from a click only.

import { useSyncExternalStore } from 'react';
import { interactionApi } from '../services/interactionApi';
import type { BrowserPermission, NoticeSurface } from '../pure/inappDisplay';

export const PROMPT_DISMISSED_STORAGE_KEY = 'vx.interaction.browserPromptDismissed';

export function readBrowserPermission(): BrowserPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function readDismissed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(PROMPT_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let dismissed = readDismissed();
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  let status: PermissionStatus | null = null;
  let closed = false;
  try {
    void navigator.permissions
      ?.query({ name: 'notifications' as PermissionName })
      .then((result) => {
        if (closed) return;
        status = result;
        result.onchange = emit;
      })
      .catch(() => undefined);
  } catch {
    /* no Permissions API: the state is re-read on the next render */
  }
  return () => {
    closed = true;
    listeners.delete(listener);
    if (status) status.onchange = null;
  };
}

/** Asks the browser (call it from a click handler); `unsupported` without the API. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    await Notification.requestPermission();
  } catch {
    /* an old browser may throw on the promise form: read back below */
  }
  emit();
  return readBrowserPermission();
}

export function dismissBrowserPrompt(): void {
  dismissed = true;
  try {
    window.localStorage.setItem(PROMPT_DISMISSED_STORAGE_KEY, '1');
  } catch {
    /* storage unavailable: the choice lasts until the page is reloaded */
  }
  emit();
}

export function useBrowserPermissionState(): { permission: BrowserPermission; dismissed: boolean } {
  useSyncExternalStore(subscribe, () => version, () => version);
  return { permission: readBrowserPermission(), dismissed };
}

/** The real browser surface of `displayNotice`: a service-worker notification when one is ready, else `new Notification`. */
export function browserSurface(showToast: () => void): NoticeSurface {
  return {
    permission: readBrowserPermission,
    showToast,
    showNative: async ({ title, body, tag, url }) => {
      try {
        const registration = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
        if (registration) {
          await registration.showNotification(title, { body, tag, data: { url } });
          return true;
        }
        if (typeof Notification === 'undefined') return false;
        const notification = new Notification(title, { body, tag });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Web Push (04 §10.5)
// ---------------------------------------------------------------------------

export function isWebPushSupported(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

/** Base64url (no padding) → bytes, the form `applicationServerKey` needs. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Service worker ready, permission (asked when still `default`: call from a click), `pushManager.subscribe` with the
 * app's VAPID key, then the subscription posted to the back. Throws `UNSUPPORTED` / `PERMISSION_DENIED` /
 * `INVALID_SUBSCRIPTION` (the settings card turns them into a message).
 */
export async function enableWebPush(): Promise<void> {
  if (!isWebPushSupported()) throw new Error('UNSUPPORTED');
  if (Notification.permission === 'default') await requestBrowserPermission();
  if (Notification.permission !== 'granted') throw new Error('PERMISSION_DENIED');
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await interactionApi.webPushPublicKey();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('INVALID_SUBSCRIPTION');
  await interactionApi.subscribeWebPush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, userAgent: navigator.userAgent.slice(0, 256) });
}

/** Unsubscribes this browser and tells the back; never throws. */
export async function disableWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const subscription = await registration?.pushManager.getSubscription().catch(() => null);
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => undefined);
  await interactionApi.unsubscribeWebPush(endpoint).catch(() => undefined);
}

export async function isThisBrowserSubscribed(): Promise<boolean> {
  if (!isWebPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
