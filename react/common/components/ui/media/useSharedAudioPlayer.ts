/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { useCallback, useSyncExternalStore } from 'react';
import { createSharedPlayerStore } from './sharedPlayerStore';
import type { SharedPlayerState, SharedPlayerStore } from './sharedPlayerStore';

let shared: SharedPlayerStore | null = null;

/** The tab-wide player (created on first use; browser only). */
export function getSharedAudioPlayer(): SharedPlayerStore {
  if (!shared) {
    const element = new Audio();
    element.preload = 'auto';
    shared = createSharedPlayerStore(element);
  }
  return shared;
}

const SERVER_STATE: SharedPlayerState = { id: null, url: null, playing: false, time: 0, duration: 0, rate: 1, blocked: false };

export interface SharedAudioPlayer {
  /** This item is the one loaded in the shared player. */
  current: boolean;
  /** This item is playing. */
  playing: boolean;
  /** Seconds played of this item (0 when another item is loaded). */
  time: number;
  /** Seconds, known once metadata is loaded (0 otherwise). */
  duration: number;
  rate: number;
  /** The last automatic play was refused by the browser. */
  blocked: boolean;
  toggle: () => void;
  play: (startAt?: number) => void;
  pause: () => void;
  /** Seek to a fraction 0..1 and play. */
  seek: (fraction: number) => void;
  setRate: (rate: number) => void;
  stop: () => void;
}

/**
 * Observable state and controls of one item (`id`, `url`) on the shared player: starting it stops whatever
 * else was playing in the tab. `rate` is global to the player.
 */
export function useSharedAudioPlayer(id: string, url: string): SharedAudioPlayer {
  const store = typeof Audio === 'undefined' ? null : getSharedAudioPlayer();
  const state = useSyncExternalStore(
    useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => undefined), [store]),
    () => (store ? store.getState() : SERVER_STATE),
    () => SERVER_STATE,
  );
  const mine = state.id === id;
  return {
    current: mine,
    playing: mine && state.playing,
    time: mine ? state.time : 0,
    duration: mine ? state.duration : 0,
    rate: state.rate,
    blocked: mine && state.blocked,
    toggle: () => store?.toggle(id, url),
    play: (startAt) => store?.play(id, url, startAt),
    pause: () => {
      if (mine) store?.pause();
    },
    seek: (fraction) => store?.seek(id, url, fraction),
    setRate: (rate) => store?.setRate(rate),
    stop: () => {
      if (mine) store?.stop();
    },
  };
}
