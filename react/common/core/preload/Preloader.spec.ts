/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi } from 'vitest';
import Preloader from './Preloader';

/** A fake preload-able service — `init` resolves asynchronously (via a
 *  microtask or an externally-controlled promise) so tests can observe
 *  ordering/concurrency, and records when it was started. */
class FakeService {
  preloadKey: string;
  startedAt: number | null = null;
  private resolveInit: (() => void) | null = null;

  constructor(name: string, private order: { seq: number }) {
    this.preloadKey = name;
  }

  init(cbOrApiUrl: any, maybeCb?: () => void): void {
    const callback = typeof maybeCb === 'function' ? maybeCb : cbOrApiUrl;
    this.startedAt = ++this.order.seq;
    // Resolves on the next microtask by default — call `settle()` to control
    // completion order explicitly from a test.
    Promise.resolve().then(() => callback());
  }
}

/** A service whose completion is controlled explicitly by the test. */
class ControlledService {
  preloadKey: string;
  startedAt: number | null = null;
  private pendingCallback: (() => void) | null = null;

  constructor(name: string, private order: { seq: number }) {
    this.preloadKey = name;
  }

  init(cbOrApiUrl: any, maybeCb?: () => void): void {
    const callback = typeof maybeCb === 'function' ? maybeCb : cbOrApiUrl;
    this.startedAt = ++this.order.seq;
    this.pendingCallback = callback;
  }

  settle(): void {
    this.pendingCallback?.();
    this.pendingCallback = null;
  }
}

describe('Preloader — two-wave parallel load (PERFORMANCE_PLAN.md §1.1)', () => {
  it('loads ConfigurationService alone first, then the rest in parallel', async () => {
    const order = { seq: 0 };
    const preloader = new Preloader();
    const config = new FakeService('ConfigurationService', order);
    const crypt = new FakeService('CryptService', order);
    const locale = new FakeService('LocaleService', order);
    const user = new FakeService('UserService', order);

    preloader.add(config);
    preloader.add(crypt);
    preloader.add(locale);
    preloader.add(user);

    preloader.load('/api');

    // ConfigurationService must be the only one started synchronously —
    // the rest only start once its callback fires.
    expect(config.startedAt).toBe(1);
    expect(crypt.startedAt).toBeNull();
    expect(locale.startedAt).toBeNull();
    expect(user.startedAt).toBeNull();

    // Let ConfigurationService's callback (queued as a microtask) run.
    await Promise.resolve();
    await Promise.resolve();

    // Wave 2 was started together (all after config, order between them
    // doesn't matter — that's the point of "parallel").
    expect(crypt.startedAt).not.toBeNull();
    expect(locale.startedAt).not.toBeNull();
    expect(user.startedAt).not.toBeNull();
    expect(Math.min(crypt.startedAt!, locale.startedAt!, user.startedAt!)).toBeGreaterThan(config.startedAt!);

    await Promise.resolve();
    await Promise.resolve();
    expect(preloader.ready()).toBe(true);
  });

  it('emits "ready" exactly once even when wave-2 services settle concurrently', async () => {
    const order = { seq: 0 };
    const preloader = new Preloader();
    const config = new ControlledService('ConfigurationService', order);
    const a = new ControlledService('ServiceA', order);
    const b = new ControlledService('ServiceB', order);
    const c = new ControlledService('ServiceC', order);

    preloader.add(config);
    preloader.add(a);
    preloader.add(b);
    preloader.add(c);

    const readySpy = vi.fn();
    preloader.addEventListener('ready', readySpy);

    preloader.load('/api');
    config.settle();

    expect(preloader.ready()).toBe(false);
    // Settle all of wave 2 "at once" (same synchronous burst) — only the last
    // one should observe nb_loaded crossing to the total and fire 'ready'.
    a.settle();
    b.settle();
    c.settle();

    expect(preloader.ready()).toBe(true);
    expect(readySpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the ConfigurationService-first semantics encoded in add() (unshift)', () => {
    const order = { seq: 0 };
    const preloader = new Preloader();
    const a = new FakeService('ServiceA', order);
    const config = new FakeService('ConfigurationService', order);
    const b = new FakeService('ServiceB', order);

    preloader.add(a);
    preloader.add(config);
    preloader.add(b);

    expect(preloader.services_names[0]).toBe('ConfigurationService');
  });

  it('falls back to loading everything in parallel when there is no ConfigurationService', async () => {
    const order = { seq: 0 };
    const preloader = new Preloader();
    const a = new FakeService('ServiceA', order);
    const b = new FakeService('ServiceB', order);

    preloader.add(a);
    preloader.add(b);
    preloader.load('/api');

    expect(a.startedAt).not.toBeNull();
    expect(b.startedAt).not.toBeNull();

    await Promise.resolve();
    await Promise.resolve();
    expect(preloader.ready()).toBe(true);
  });

  it('emits "ready" synchronously when no services are registered', () => {
    const preloader = new Preloader();
    const readySpy = vi.fn();
    preloader.addEventListener('ready', readySpy);
    preloader.load('/api');
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(preloader.ready()).toBe(false); // 0/0 — matches pre-existing ready() semantics (nb_loaded > 0 required)
  });
});
