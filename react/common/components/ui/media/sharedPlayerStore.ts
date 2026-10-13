/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


/** The subset of `HTMLAudioElement` the shared player uses (lets tests drive a fake element). */
export interface AudioElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  preservesPitch?: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
}

export interface SharedPlayerState {
  /** Id of what is loaded in the player (null when nothing). */
  id: string | null;
  url: string | null;
  playing: boolean;
  /** Seconds. */
  time: number;
  /** Seconds, 0 while unknown. */
  duration: number;
  rate: number;
  /** True when the last play request was refused (browser autoplay policy) or failed. */
  blocked: boolean;
}

export interface SharedPlayerStore {
  getState(): SharedPlayerState;
  subscribe(listener: () => void): () => void;
  /** Play when paused (or when another item is loaded), pause when this item is playing. */
  toggle(id: string, url: string, startAt?: number): void;
  /** Start playing (never pauses): safe for automatic playback. */
  play(id: string, url: string, startAt?: number): void;
  pause(): void;
  /** Jump to `fraction` (0..1) of the item and play. */
  seek(id: string, url: string, fraction: number): void;
  setRate(rate: number): void;
  stop(): void;
  dispose(): void;
}

export interface SharedPlayerOptions {
  /** Time-update period in ms while playing. */
  tickMs?: number;
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** One audio element per store: playing an item replaces whatever was playing, so a tab never plays two sounds. */
export function createSharedPlayerStore(element: AudioElementLike, options: SharedPlayerOptions = {}): SharedPlayerStore {
  const tickMs = options.tickMs ?? 50;
  const listeners = new Set<() => void>();
  let state: SharedPlayerState = { id: null, url: null, playing: false, time: 0, duration: 0, rate: 1, blocked: false };
  let ticker: ReturnType<typeof setInterval> | undefined;

  const set = (patch: Partial<SharedPlayerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const stopTicker = () => {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  };
  const startTicker = () => {
    stopTicker();
    ticker = setInterval(() => set({ time: element.currentTime, duration: finite(element.duration) || state.duration }), tickMs);
  };

  element.addEventListener('play', () => {
    startTicker();
    set({ playing: true, blocked: false });
  });
  element.addEventListener('pause', () => {
    stopTicker();
    set({ playing: false, time: element.currentTime });
  });
  element.addEventListener('ended', () => {
    stopTicker();
    set({ playing: false, time: 0 });
  });
  element.addEventListener('loadedmetadata', () => set({ duration: finite(element.duration) }));

  const load = (id: string, url: string) => {
    if (state.id === id && state.url === url) return;
    element.src = url;
    element.playbackRate = state.rate;
    set({ id, url, time: 0, duration: 0, playing: false, blocked: false });
  };
  const start = () => {
    element.play().catch(() => set({ playing: false, blocked: true }));
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    toggle(id, url, startAt) {
      load(id, url);
      if (startAt !== undefined) element.currentTime = startAt;
      if (element.paused) start();
      else element.pause();
    },
    play(id, url, startAt) {
      if (state.id === id && state.playing && startAt === undefined) return;
      load(id, url);
      if (startAt !== undefined) element.currentTime = startAt;
      if (element.paused) start();
    },
    pause() {
      element.pause();
    },
    seek(id, url, fraction) {
      load(id, url);
      const go = () => {
        element.currentTime = Math.max(0, Math.min(1, fraction)) * finite(element.duration);
        set({ time: element.currentTime });
        if (element.paused) start();
      };
      if (finite(element.duration) > 0) go();
      else element.addEventListener('loadedmetadata', go, { once: true });
    },
    setRate(rate) {
      element.playbackRate = rate;
      element.preservesPitch = true;
      set({ rate });
    },
    stop() {
      element.pause();
      element.currentTime = 0;
      set({ id: null, url: null, playing: false, time: 0, duration: 0 });
    },
    dispose() {
      stopTicker();
      listeners.clear();
    },
  };
}
