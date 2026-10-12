/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { appSession } from '../core/session/AppSession';
import { adminTokenAuth } from './adminTokenAuth';

export interface SessionPrincipal {
  id: number | string;
  admin: boolean;
  email?: string;
  [key: string]: unknown;
}

export interface SessionAuthPort {
  readonly mode: 'users' | 'anonymous';
  isAuth(): boolean;
  isAdmin(): boolean;
  get(): SessionPrincipal | null;
  clear(): void;
  /** Persist the UI language for the signed-in principal (no-op when anonymous). */
  setLocale(lang: string): void;
}

/** appSession key observed by `useSessionKeys(['user'])`. */
export const SESSION_AUTH_KEY = 'user';

let current: SessionAuthPort = adminTokenAuth;

/**
 * Replace the active auth port (last registration wins) and notify subscribers of the `'user'` session key.
 * The `user` module calls this at import time; without it the anonymous admin-token port stays active.
 */
export function registerSessionAuth(port: SessionAuthPort): void {
  current = port;
  appSession.dispatchEvent(SESSION_AUTH_KEY, { key: SESSION_AUTH_KEY, value: port.get() });
}

/** Stable facade delegating to the registered port (safe to import once and keep). */
export const sessionAuth: SessionAuthPort = {
  get mode() {
    return current.mode;
  },
  isAuth: () => current.isAuth(),
  isAdmin: () => current.isAdmin(),
  get: () => current.get(),
  clear: () => current.clear(),
  setLocale: (lang: string) => current.setLocale(lang),
};

export function isUserManagementEnabled(): boolean {
  return sessionAuth.mode === 'users';
}
