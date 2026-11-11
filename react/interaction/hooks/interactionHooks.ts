/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Hooks of the module (04 §10.1). Server data is read over REST and kept fresh by the `interaction.inbox` stream
// (`useLiveResource`: invalidations only, polling only while the stream is unavailable).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { eventStreamClient } from '../../common/core/events/eventStream';
import type { ServerEvent } from '../../common/core/events/types';
import { useLiveResource } from '../../common/core/events/useLiveResource';
import { decideInappDisplay, shouldPromptForPermission, type BrowserPermission } from '../pure/inappDisplay';
import { answerWithStepUp, type InteractionStepUpHandler } from '../pure/stepUp';
import { interactionApi } from '../services/interactionApi';
import {
  dismissBrowserPrompt,
  disableWebPush,
  enableWebPush,
  isThisBrowserSubscribed,
  isWebPushSupported,
  requestBrowserPermission,
  useBrowserPermissionState,
} from '../browser/browserNotifications';
import type {
  InboxDto,
  InappDisplay,
  InteractionApiError,
  InteractionChannelAdminDto,
  InteractionChannelDto,
  InteractionErrorCode,
  InteractionNoticeDto,
  InteractionPrefBody,
  InteractionPrefDto,
  InteractionTicketDto,
  TelegramLinkCodeDto,
} from '../types/interactionTypes';

export const INBOX_TOPIC = 'interaction.inbox';
const FALLBACK_POLL_MS = 30_000;

function codeOf(error: unknown): InteractionErrorCode {
  return (error as InteractionApiError | null)?.code ?? 'UNKNOWN';
}

export interface InteractionInbox {
  tickets: InboxDto['tickets'];
  notices: InteractionNoticeDto[];
  unread: number;
  loading: boolean;
  refetch: () => void;
  markRead: (ids: string[] | 'all') => Promise<void>;
}

export function useInteractionInbox(): InteractionInbox {
  const live = useLiveResource(() => interactionApi.inbox(), { topics: [INBOX_TOPIC], fallbackPollMs: FALLBACK_POLL_MS });
  const { refetch } = live;
  const markRead = useCallback(
    async (ids: string[] | 'all') => {
      await interactionApi.markRead(ids);
      await refetch();
    },
    [refetch],
  );
  return {
    tickets: live.data?.tickets ?? [],
    notices: live.data?.notices ?? [],
    unread: live.data?.unread ?? 0,
    loading: live.loading,
    refetch: () => void refetch(),
    markRead,
  };
}

export type { InteractionStepUpHandler };
let stepUpHandler: InteractionStepUpHandler | null = null;
const stepUpListeners = new Set<() => void>();

/** Registers the UI that obtains a recent proof of identity (04 §21); the last registration wins. */
export function registerInteractionStepUp(handler: InteractionStepUpHandler | null): void {
  stepUpHandler = handler;
  for (const listener of stepUpListeners) listener();
}

/** Whether an app registered a step-up UI (the modal cannot offer a `freshProof` answer without one). */
export function useHasInteractionStepUp(): boolean {
  return useSyncExternalStore(
    (listener) => {
      stepUpListeners.add(listener);
      return () => void stepUpListeners.delete(listener);
    },
    () => stepUpHandler !== null,
    () => false,
  );
}

export interface InteractionTicketState {
  ticket: InteractionTicketDto | null;
  answer: (actionId: string, stepUpProof?: string) => Promise<boolean>;
  answering: boolean;
  error: InteractionErrorCode | null;
  reload: () => void;
}

export function useInteractionTicket(id: string | null): InteractionTicketState {
  const live = useLiveResource(() => (id ? interactionApi.ticket(id) : Promise.resolve(null)), {
    topics: id ? [INBOX_TOPIC] : [],
    match: (event) => event.id === id,
    fallbackPollMs: FALLBACK_POLL_MS,
  });
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<InteractionErrorCode | null>(null);
  const { refetch } = live;
  const answer = useCallback(
    async (actionId: string, stepUpProof?: string): Promise<boolean> => {
      const ticket = live.data;
      if (!id || !ticket) return false;
      setAnswering(true);
      setError(null);
      try {
        const outcome = await answerWithStepUp({
          ticketId: id,
          fallbackPurpose: ticket.stepUpPurpose,
          proof: stepUpProof,
          handler: stepUpHandler,
          send: (proof) => interactionApi.answer(id, actionId, proof),
        });
        if (outcome === 'cancelled') return false;
        await refetch();
        return true;
      } catch (caught) {
        setError(codeOf(caught));
        await refetch();
        return false;
      } finally {
        setAnswering(false);
      }
    },
    [id, live.data, refetch],
  );
  return { ticket: live.data ?? null, answer, answering, error, reload: () => void refetch() };
}

/**
 * The `interaction.inbox` stream with the connection events `useServerEvents` hides: `onResync` runs when the server
 * asks to reload everything and when the stream comes back from a failure (events may have been missed).
 */
export function useInboxStream(onEvent: (event: ServerEvent) => void, onResync: () => void): void {
  const eventRef = useRef(onEvent);
  const resyncRef = useRef(onResync);
  eventRef.current = onEvent;
  resyncRef.current = onResync;
  useEffect(() => {
    const stop = eventStreamClient.subscribe([INBOX_TOPIC], (event) => eventRef.current(event), { onResync: () => resyncRef.current() });
    let last = eventStreamClient.getState();
    const unwatch = eventStreamClient.onStateChange((state) => {
      if (last === 'fallback' && state !== 'fallback') resyncRef.current();
      last = state;
    });
    return () => {
      stop();
      unwatch();
    };
  }, []);
}

export interface InteractionChannels {
  channels: InteractionChannelDto[];
  loading: boolean;
  error: InteractionErrorCode | null;
  configure: (kind: string, input: Record<string, unknown>) => Promise<string | null>;
  setState: (kind: string, state: { enabled?: boolean; position?: number }) => Promise<void>;
  remove: (kind: string) => Promise<void>;
  test: (kind: string) => Promise<{ ok: boolean; code: string | null }>;
  verify: (kind: string, code: string) => Promise<void>;
  rotateWebhookSecret: () => Promise<string | null>;
  telegramLinkCode: () => Promise<TelegramLinkCodeDto>;
  unlinkTelegram: (linkId: string) => Promise<void>;
  refetch: () => void;
}

/** Every call rethrows the API error (`{ code }`) after refreshing the list: the cards show the code's label. */
export function useInteractionChannels(): InteractionChannels {
  const live = useLiveResource(() => interactionApi.channels(), { topics: [INBOX_TOPIC], match: (event) => event.type === 'channels.changed', fallbackPollMs: FALLBACK_POLL_MS });
  const [error, setError] = useState<InteractionErrorCode | null>(null);
  const { refetch } = live;
  const run = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        return await work();
      } catch (caught) {
        setError(codeOf(caught));
        throw caught;
      } finally {
        await refetch();
      }
    },
    [refetch],
  );
  return useMemo(
    () => ({
      channels: live.data ?? [],
      loading: live.loading,
      error,
      configure: (kind, input) => run(async () => (await interactionApi.configure(kind, input)).secret),
      setState: (kind, state) => run(async () => void (await interactionApi.setState(kind, state))),
      remove: (kind) => run(async () => void (await interactionApi.remove(kind))),
      test: (kind) => run(() => interactionApi.test(kind)),
      verify: (kind, code) => run(async () => void (await interactionApi.verify(kind, code))),
      rotateWebhookSecret: () => run(async () => (await interactionApi.rotateWebhookSecret()).secret),
      telegramLinkCode: () => run(() => interactionApi.telegramLinkCode()),
      unlinkTelegram: (linkId) => run(async () => void (await interactionApi.unlinkTelegram(linkId))),
      refetch: () => void refetch(),
    }),
    [live.data, live.loading, error, run, refetch],
  );
}

export interface InteractionPrefs {
  prefs: InteractionPrefDto | null;
  error: InteractionErrorCode | null;
  save: (patch: InteractionPrefBody) => Promise<boolean>;
}

export function useInteractionPrefs(): InteractionPrefs {
  const live = useLiveResource(() => interactionApi.prefs(), { topics: [INBOX_TOPIC], match: (event) => event.type === 'channels.changed', fallbackPollMs: 0 });
  const [error, setError] = useState<InteractionErrorCode | null>(null);
  const { refetch } = live;
  const save = useCallback(
    async (patch: InteractionPrefBody): Promise<boolean> => {
      setError(null);
      try {
        await interactionApi.savePrefs(patch);
        await refetch();
        return true;
      } catch (caught) {
        setError(codeOf(caught));
        return false;
      }
    },
    [refetch],
  );
  return { prefs: live.data ?? null, error, save };
}

export interface InteractionAdminChannels {
  rows: InteractionChannelAdminDto[];
  loading: boolean;
  error: InteractionErrorCode | null;
  setAdminDisabled: (userId: number, kind: string, disabled: boolean) => Promise<void>;
}

export function useInteractionAdminChannels(filter: { userId?: number; kind?: string } = {}): InteractionAdminChannels {
  const { userId, kind } = filter;
  const [rows, setRows] = useState<InteractionChannelAdminDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<InteractionErrorCode | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await interactionApi.adminChannels({ userId, kind }));
      setError(null);
    } catch (caught) {
      setError(codeOf(caught));
    } finally {
      setLoading(false);
    }
  }, [userId, kind]);
  useEffect(() => {
    void load();
  }, [load]);
  const setAdminDisabled = useCallback(
    async (owner: number, channelKind: string, disabled: boolean) => {
      try {
        await interactionApi.adminSetDisabled(owner, channelKind, disabled);
      } catch (caught) {
        setError(codeOf(caught));
      }
      await load();
    },
    [load],
  );
  return { rows, loading, error, setAdminDisabled };
}

export interface BrowserNotificationPermissionState {
  permission: BrowserPermission;
  /** Call from a click only (the browser asks on a user gesture). */
  request: () => Promise<BrowserPermission>;
  dismissed: boolean;
  dismiss: () => void;
}

export function useBrowserNotificationPermission(): BrowserNotificationPermissionState {
  const { permission, dismissed } = useBrowserPermissionState();
  return { permission, request: requestBrowserPermission, dismissed, dismiss: dismissBrowserPrompt };
}

/** The display a notice gets now (wanted display + live permission). */
export function useEffectiveInappDisplay(wanted: InappDisplay | null | undefined): { decision: 'native' | 'toast'; prompt: boolean } {
  const { permission, dismissed } = useBrowserPermissionState();
  return { decision: decideInappDisplay(wanted, permission), prompt: shouldPromptForPermission(wanted, permission, dismissed) };
}

const WEB_PUSH_ERRORS = ['UNSUPPORTED', 'PERMISSION_DENIED', 'INVALID_SUBSCRIPTION'];

/** The label key of a Web Push failure: a known browser step, an API code, or a generic failure (never a raw message). */
export function webPushErrorLabel(caught: unknown): string {
  if (caught instanceof Error) return `interaction.channels.browser.pushError.${WEB_PUSH_ERRORS.includes(caught.message) ? caught.message : 'FAILED'}`;
  const code = codeOf(caught);
  return code === 'UNKNOWN' ? 'interaction.channels.browser.pushError.FAILED' : `interaction.errors.${code}`;
}

export interface WebPushState {
  supported: boolean;
  subscribed: boolean;
  busy: boolean;
  /** A label key (`interaction.…`), null without error. */
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export function useWebPush(): WebPushState {
  const supported = isWebPushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void isThisBrowserSubscribed().then((value) => alive && setSubscribed(value));
    return () => {
      alive = false;
    };
  }, []);
  const wrap = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(webPushErrorLabel(caught));
    } finally {
      setSubscribed(await isThisBrowserSubscribed());
      setBusy(false);
    }
  }, []);
  return { supported, subscribed, busy, error, enable: () => wrap(enableWebPush), disable: () => wrap(disableWebPush) };
}
