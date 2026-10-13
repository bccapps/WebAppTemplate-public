/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LiveResourceController,
  LIVE_REFETCH_GROUP_MS,
  type LiveStreamSource,
  type LiveResourceControllerOptions,
} from './liveResourceController';
import type { ServerEvent, StreamState } from './types';

function setup(options: Partial<LiveResourceControllerOptions> = {}, load?: () => Promise<void>) {
  let state: StreamState = 'open';
  let onEvent: (e: ServerEvent) => void = () => undefined;
  let onResync: () => void = () => undefined;
  let onState: (s: StreamState) => void = () => undefined;
  let onDenied: (d: string[]) => void = () => undefined;
  let denied: string[] = [];
  let onVisible: () => void = () => undefined;
  let visible = true;
  const unsubscribe = vi.fn();
  const source: LiveStreamSource = {
    subscribe: (_topics, handler, opts) => {
      onEvent = handler;
      onResync = opts?.onResync ?? (() => undefined);
      onDenied = opts?.onDenied ?? (() => undefined);
      return unsubscribe;
    },
    getDeniedTopics: () => denied,
    getState: () => state,
    onStateChange: (l) => {
      onState = l;
      return () => undefined;
    },
  };
  const loader = vi.fn(load ?? (async () => undefined));
  const controller = new LiveResourceController(
    { topics: ['a.x'], fallbackPollMs: 5000, ...options },
    {
      source,
      load: loader,
      isVisible: () => visible,
      watchVisible: (l) => {
        onVisible = l;
        return () => undefined;
      },
    },
  );
  return {
    controller,
    loader,
    unsubscribe,
    emit: (e: Partial<ServerEvent> = {}) => onEvent({ topic: 'a.x', type: 't', ...e }),
    resync: () => onResync(),
    setState: (s: StreamState) => {
      state = s;
      onState(s);
    },
    initialDenied: (d: string[]) => {
      denied = d;
    },
    deny: (d: string[]) => {
      denied = d;
      onDenied(d);
    },
    setVisible: (v: boolean) => {
      visible = v;
      if (v) onVisible();
    },
    initialState: (s: StreamState) => {
      state = s;
    },
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('LiveResourceController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once at start', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    expect(t.loader).toHaveBeenCalledTimes(1);
  });

  it('groups a burst of events into one refetch after 250 ms', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    t.emit();
    t.emit();
    await tick(100);
    t.emit();
    await tick(LIVE_REFETCH_GROUP_MS - 100 - 1);
    expect(t.loader).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(t.loader).toHaveBeenCalledTimes(2);
  });

  it('only refetches for events accepted by match', async () => {
    const t = setup({ match: (e) => e.id === 2 });
    t.controller.start();
    await tick(0);
    t.emit({ id: 1 });
    await tick(500);
    expect(t.loader).toHaveBeenCalledTimes(1);
    t.emit({ id: 2 });
    await tick(300);
    expect(t.loader).toHaveBeenCalledTimes(2);
  });

  it('refetches on resync unless disabled', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    t.resync();
    await tick(300);
    expect(t.loader).toHaveBeenCalledTimes(2);
    const off = setup({ refetchOnResync: false });
    off.controller.start();
    await tick(0);
    off.resync();
    await tick(300);
    expect(off.loader).toHaveBeenCalledTimes(1);
  });

  it('polls only while in fallback and refetches when leaving it', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    await tick(20_000);
    expect(t.loader).toHaveBeenCalledTimes(1);
    t.setState('fallback');
    await tick(5000);
    await tick(5000);
    expect(t.loader).toHaveBeenCalledTimes(3);
    t.setState('open');
    await tick(300);
    expect(t.loader).toHaveBeenCalledTimes(4);
    await tick(20_000);
    expect(t.loader).toHaveBeenCalledTimes(4);
  });

  it('starts polling right away when the stream is already in fallback, skipping hidden ticks', async () => {
    const t = setup();
    t.initialState('fallback');
    const hidden = setup();
    hidden.initialState('fallback');
    t.controller.start();
    hidden.controller.start();
    await tick(0);
    hidden.setVisible(false);
    await tick(5000);
    expect(t.loader).toHaveBeenCalledTimes(2);
    expect(hidden.loader).toHaveBeenCalledTimes(1);
  });

  it('refetches when the tab becomes visible again', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    t.setVisible(true);
    await tick(300);
    expect(t.loader).toHaveBeenCalledTimes(2);
  });

  it('never runs two reads at once and replays one trailing read', async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<void>((r) => (release = r)));
    const t = setup({}, slow);
    t.controller.start();
    await tick(0);
    t.emit();
    await tick(300);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await tick(0);
    expect(slow).toHaveBeenCalledTimes(2);
    release();
  });

  it('stop unsubscribes and cancels timers', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    t.emit();
    t.controller.stop();
    await tick(10_000);
    expect(t.unsubscribe).toHaveBeenCalledTimes(1);
    expect(t.loader).toHaveBeenCalledTimes(1);
  });

  it('polls while a topic is denied even though the stream is open, and stops when it is no longer denied', async () => {
    const t = setup();
    t.controller.start();
    await tick(0);
    expect(t.loader).toHaveBeenCalledTimes(1);
    await tick(5000);
    expect(t.loader).toHaveBeenCalledTimes(1);
    t.deny(['a.x']);
    await tick(5000);
    expect(t.loader).toHaveBeenCalledTimes(2);
    t.deny([]);
    await tick(10_000);
    expect(t.loader).toHaveBeenCalledTimes(2);
    t.controller.stop();
  });

  it('polls from the start when the topic is already known as denied', async () => {
    const t = setup();
    t.initialDenied(['a.x']);
    t.controller.start();
    await tick(0);
    await tick(5000);
    expect(t.loader).toHaveBeenCalledTimes(2);
    t.controller.stop();
  });

  it('does not poll for denied topics when fallbackPollMs is 0', async () => {
    const t = setup({ fallbackPollMs: 0 });
    t.controller.start();
    await tick(0);
    t.deny(['a.x']);
    await tick(60_000);
    expect(t.loader).toHaveBeenCalledTimes(1);
    t.controller.stop();
  });
});
