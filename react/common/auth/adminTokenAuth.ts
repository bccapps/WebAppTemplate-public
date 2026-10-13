/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import axios from 'axios';
import { httpService } from '../core/http/HttpService';
import { appSession } from '../core/session/AppSession';
import { configurationService } from '../services/ConfigurationService';
import type { SessionAuthPort, SessionPrincipal } from './sessionAuth';

const STORAGE_KEY = 'vx_admin_token';
const SESSION_KEY = 'user';

/** In-memory fallback when sessionStorage is unavailable. */
let memoryToken: string | null = null;

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function writeStored(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable: memory only
  }
}

function setBearer(token: string | null): void {
  if (token === null) delete axios.defaults.headers.common['Authorization'];
  else axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
}

function notify(): void {
  appSession.dispatchEvent(SESSION_KEY, { key: SESSION_KEY, value: adminTokenAuth.get() });
}

interface SessionProbe {
  ok: boolean;
  mode?: string;
}

function probe(): Promise<SessionProbe> {
  const url = configurationService.getApiUrl('common') + '/admin-session';
  return new Promise<SessionProbe>((resolve) => {
    httpService
      .get(url)
      .then((data?: { mode?: string }) => resolve({ ok: true, mode: data?.mode }))
      .fail(() => resolve({ ok: false }))
      .error(() => resolve({ ok: false }))
      .notAuthorized(() => resolve({ ok: false }));
  });
}

class AdminTokenAuth implements SessionAuthPort {
  /** True once the back answered `mode: 'local-trust'` (LOCAL_TRUST=true, genuine local request): no key needed. */
  private localTrust = false;
  private detection: Promise<boolean> | null = null;

  get mode(): 'anonymous' | 'local-trust' {
    return this.localTrust ? 'local-trust' : 'anonymous';
  }

  /**
   * Ask the back once whether it trusts this client without a key (local trust mode). Safe to call repeatedly;
   * resolves true in local trust mode. Skipped when a key is already stored.
   */
  detectLocalTrust(): Promise<boolean> {
    if (this.localTrust) return Promise.resolve(true);
    if (readStored() !== null) return Promise.resolve(false);
    this.detection ??= probe().then((r) => {
      this.localTrust = r.ok && r.mode === 'local-trust';
      if (this.localTrust) notify();
      return this.localTrust;
    });
    return this.detection;
  }

  /** Validate `token` against the backend; on success keep it (sessionStorage) and use it as Bearer. */
  async login(token: string): Promise<boolean> {
    const previous = readStored();
    setBearer(token);
    const { ok } = await probe();
    if (!ok) {
      setBearer(previous);
      return false;
    }
    writeStored(token);
    notify();
    return true;
  }

  /** Re-apply a stored token as Bearer (no network call; a later 401 goes through the unauthorized handler). */
  restore(): void {
    const token = readStored();
    if (token) setBearer(token);
  }

  isAuth(): boolean {
    return this.localTrust || readStored() !== null;
  }

  isAdmin(): boolean {
    return this.isAuth();
  }

  get(): SessionPrincipal | null {
    return this.isAuth() ? { id: 0, admin: true } : null;
  }

  clear(): void {
    writeStored(null);
    setBearer(null);
    notify();
  }

  setLocale(_lang: string): void {
    // anonymous: nothing to persist
  }
}

export const adminTokenAuth = new AdminTokenAuth();
adminTokenAuth.restore();
