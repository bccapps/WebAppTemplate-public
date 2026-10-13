/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createSharedPlayerStore } from './sharedPlayerStore';
import type { AudioElementLike } from './sharedPlayerStore';

class FakeAudio implements AudioElementLike {
  private source = '';
  get src() {
    return this.source;
  }
  // Like a real element: loading a new source stops playback (no pause event).
  set src(value: string) {
    this.source = value;
    this.paused = true;
    this.currentTime = 0;
  }
  currentTime = 0;
  duration = NaN;
  paused = true;
  playbackRate = 1;
  preservesPitch?: boolean;
  refuse = false;
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }) {
    const wrapped = options?.once ? () => (this.off(type, wrapped), listener()) : listener;
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), wrapped]);
  }
  private off(type: string, fn: () => void) {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn));
  }
  emit(type: string) {
    [...(this.handlers.get(type) ?? [])].forEach((h) => h());
  }
  play() {
    if (this.refuse) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  loadMetadata(duration: number) {
    this.duration = duration;
    this.emit('loadedmetadata');
  }
}

describe('shared player store', () => {
  let audio: FakeAudio;
  beforeEach(() => {
    vi.useFakeTimers();
    audio = new FakeAudio();
  });
  afterEach(() => vi.useRealTimers());

  it('loads and plays an item, then pauses on a second toggle', () => {
    const store = createSharedPlayerStore(audio);
    store.toggle('a', '/a.wav');
    expect(audio.src).toBe('/a.wav');
    expect(store.getState()).toMatchObject({ id: 'a', playing: true });
    store.toggle('a', '/a.wav');
    expect(store.getState().playing).toBe(false);
  });

  it('plays one sound at a time: a second item replaces the first', () => {
    const store = createSharedPlayerStore(audio);
    store.toggle('a', '/a.wav');
    store.toggle('b', '/b.wav');
    expect(audio.src).toBe('/b.wav');
    expect(store.getState().id).toBe('b');
    expect(store.getState().time).toBe(0);
    expect(store.getState().playing).toBe(true);
    expect(audio.paused).toBe(false);
  });

  it('play() never pauses an item that is already playing (automatic playback)', () => {
    const store = createSharedPlayerStore(audio);
    store.play('a', '/a.wav');
    store.play('a', '/a.wav');
    expect(store.getState().playing).toBe(true);
  });

  it('flags a refused play (browser autoplay policy)', async () => {
    audio.refuse = true;
    const store = createSharedPlayerStore(audio);
    store.play('a', '/a.wav');
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ playing: false, blocked: true });
  });

  it('updates time while playing and stops the ticker on pause', () => {
    const store = createSharedPlayerStore(audio, { tickMs: 50 });
    store.toggle('a', '/a.wav');
    audio.duration = 10;
    audio.currentTime = 2.5;
    vi.advanceTimersByTime(60);
    expect(store.getState()).toMatchObject({ time: 2.5, duration: 10 });
    audio.pause();
    audio.currentTime = 7;
    vi.advanceTimersByTime(200);
    expect(store.getState().time).toBe(2.5);
  });

  it('resets on ended', () => {
    const store = createSharedPlayerStore(audio);
    store.toggle('a', '/a.wav');
    audio.emit('ended');
    expect(store.getState()).toMatchObject({ playing: false, time: 0 });
  });

  it('seeks immediately when the duration is known, else after metadata loads', () => {
    const store = createSharedPlayerStore(audio);
    store.seek('a', '/a.wav', 0.25);
    expect(audio.currentTime).toBe(0);
    audio.loadMetadata(20);
    expect(audio.currentTime).toBe(5);
    expect(store.getState().playing).toBe(true);
    store.seek('a', '/a.wav', 2);
    expect(audio.currentTime).toBe(20);
  });

  it('keeps the rate across items and notifies subscribers', () => {
    const store = createSharedPlayerStore(audio);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setRate(1.5);
    store.toggle('a', '/a.wav');
    expect(audio.playbackRate).toBe(1.5);
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    store.setRate(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stop() unloads the item', () => {
    const store = createSharedPlayerStore(audio);
    store.toggle('a', '/a.wav');
    store.stop();
    expect(store.getState()).toMatchObject({ id: null, playing: false, time: 0 });
    expect(audio.currentTime).toBe(0);
  });
});
