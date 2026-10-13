/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { eventStreamClient } from './eventStream';
import { LiveResourceController, type LiveResourceControllerOptions } from './liveResourceController';
import type { StreamState } from './types';

export type UseLiveResourceOptions = LiveResourceControllerOptions;

export interface LiveResource<T> {
  data: T | undefined;
  /** True until the first read settles. */
  loading: boolean;
  /** Error of the last read, cleared by the next successful one. */
  error: unknown;
  /** Reads now. */
  refetch: () => Promise<void>;
  /** State of the shared stream: `fallback` means the resource is being polled. */
  streamState: StreamState;
}

function watchVisibility(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const onChange = () => document.visibilityState === 'visible' && listener();
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Builds the read function of one subscription; results are dropped once `live.active` is false. */
function createLoader<T>(
  fetcherRef: { current: () => Promise<T> },
  live: { active: boolean },
  setData: (value: T) => void,
  setError: (error: unknown) => void,
  setLoading: (loading: boolean) => void,
): () => Promise<void> {
  return async () => {
    try {
      const value = await fetcherRef.current();
      if (live.active) {
        setData(value);
        setError(undefined);
      }
    } catch (e) {
      if (live.active) setError(e);
    } finally {
      if (live.active) setLoading(false);
    }
  };
}

/**
 * Loads a resource and keeps it fresh: refetches (grouped over 250 ms) when a matching server event arrives, polls
 * every `fallbackPollMs` while the stream is in `fallback`, and refetches when the tab becomes visible again.
 * `fetcher` may change between renders; the live subscription only follows `topics`, `fallbackPollMs` and
 * `refetchOnResync`.
 */
export function useLiveResource<T>(fetcher: () => Promise<T>, options: UseLiveResourceOptions): LiveResource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [streamState, setStreamState] = useState<StreamState>(eventStreamClient.getState());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const controllerRef = useRef<LiveResourceController | null>(null);
  const topicsKey = [...new Set(options.topics)].sort().join(',');

  useEffect(() => {
    const live = { active: true };
    const load = createLoader(fetcherRef, live, setData, setError, setLoading);
    const controller = new LiveResourceController(
      {
        topics: topicsKey === '' ? [] : topicsKey.split(','),
        match: (event) => optionsRef.current.match?.(event) ?? true,
        fallbackPollMs: options.fallbackPollMs,
        refetchOnResync: options.refetchOnResync,
      },
      { source: eventStreamClient, load, isVisible, watchVisible: watchVisibility },
    );
    controllerRef.current = controller;
    controller.start();
    const unwatch = eventStreamClient.onStateChange(setStreamState);
    return () => {
      live.active = false;
      controller.stop();
      unwatch();
      controllerRef.current = null;
    };
  }, [topicsKey, options.fallbackPollMs, options.refetchOnResync]);

  const refetch = useCallback(() => controllerRef.current?.refresh() ?? Promise.resolve(), []);
  return { data, loading, error, refetch, streamState };
}
