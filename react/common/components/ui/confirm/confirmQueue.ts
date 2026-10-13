/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Options of a confirmation dialog. Every text is an i18n key (no hard-coded text). */
export interface ConfirmOptions {
  titleId: string;
  messageId?: string;
  /** Substituted into `{0}`, `{1}`... of the message. */
  params?: (string | number)[];
  /** Defaults to `common.ui.confirm.confirm`. */
  confirmLabelId?: string;
  /** Defaults to `common.ui.confirm.cancel`. */
  cancelLabelId?: string;
  /** Destructive action: red confirm button, and the focus starts on "cancel". */
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export interface ConfirmQueue {
  /** Queues a confirmation; resolves true on confirm, false on cancel/Escape/backdrop. */
  enqueue(options: ConfirmOptions): Promise<boolean>;
  /** The request being displayed (stable reference until it is settled), or null. */
  current(): ConfirmOptions | null;
  /** Settles the displayed request and moves on to the next one. No-op when none is displayed. */
  settle(ok: boolean): void;
  subscribe(listener: () => void): () => void;
}

/** Sequential queue: two `confirm()` calls never overlap, the second is shown after the first is answered. */
export function createConfirmQueue(): ConfirmQueue {
  const pending: PendingConfirm[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    enqueue(options) {
      return new Promise<boolean>((resolve) => {
        pending.push({ options, resolve });
        notify();
      });
    },
    current: () => pending[0]?.options ?? null,
    settle(ok) {
      const head = pending.shift();
      if (!head) return;
      head.resolve(ok);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const confirmQueue: ConfirmQueue = createConfirmQueue();
