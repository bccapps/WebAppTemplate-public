/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { configurationService } from '../../services/ConfigurationService';
import { httpService } from '../http/HttpService';
import { appSession } from '../session/AppSession';
import { EventStreamClient, type EventStreamDeps } from './EventStreamClient';

/** Stable identity of the session user (`null` = signed out), so that mere profile updates do not reconnect. */
export function sessionIdentity(user: unknown): string | null {
  if (user === null || user === undefined) return null;
  const record = user as { id?: unknown; userId?: unknown; email?: unknown };
  const id = record.id ?? record.userId ?? record.email;
  return id === undefined ? JSON.stringify(user) : String(id);
}

const defaultDeps: EventStreamDeps = {
  streamGet: (url, options) => httpService.streamGet(url, options),
  baseUrl: () => configurationService.getApiUrl(),
  random: () => Math.random(),
  watchSession: (listener) => {
    const id = appSession.addEventListener('user', (event: { value?: unknown }) =>
      listener(sessionIdentity(event?.value)),
    );
    return () => appSession.removeEventListerner(id);
  },
  watchTokenRefresh: (listener) => httpService.onTokenRefreshed(listener),
};

/** The tab-wide event stream. Prefer the `useServerEvents` / `useLiveResource` hooks over using it directly. */
export const eventStreamClient = new EventStreamClient(defaultDeps);
