/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, vi } from 'vitest';
import { createConfirmQueue } from './confirmQueue';

describe('createConfirmQueue', () => {
  it('resolves true on confirm and false on cancel, in arrival order', async () => {
    const queue = createConfirmQueue();
    const first = queue.enqueue({ titleId: 'a' });
    const second = queue.enqueue({ titleId: 'b', danger: true });

    expect(queue.current()?.titleId).toBe('a');
    queue.settle(true);
    await expect(first).resolves.toBe(true);

    expect(queue.current()).toEqual({ titleId: 'b', danger: true });
    queue.settle(false);
    await expect(second).resolves.toBe(false);
    expect(queue.current()).toBeNull();
  });

  it('keeps a stable reference for the displayed request (useSyncExternalStore contract)', () => {
    const queue = createConfirmQueue();
    void queue.enqueue({ titleId: 'a' });
    expect(queue.current()).toBe(queue.current());
  });

  it('ignores settle() when nothing is displayed', () => {
    const queue = createConfirmQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.settle(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on enqueue and settle, and stops after unsubscribe', () => {
    const queue = createConfirmQueue();
    const listener = vi.fn();
    const off = queue.subscribe(listener);
    void queue.enqueue({ titleId: 'a' });
    queue.settle(true);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    void queue.enqueue({ titleId: 'b' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
