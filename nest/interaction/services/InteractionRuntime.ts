/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { InteractionRenderHook, RenderedMessage } from '../types/providerTypes';

/**
 * Work the module starts without awaiting it (the external channels of a question, the hand-over of an outcome): kept
 * here so that shutdown and tests can wait for it (`idle()`), and so that an error is logged by code, never thrown away.
 */
@Injectable()
export class InteractionBackground implements OnApplicationShutdown {
  private readonly logger = new Logger('InteractionBackground');
  private readonly running = new Set<Promise<void>>();

  run(label: string, work: () => Promise<void>): void {
    const task: Promise<void> = Promise.resolve()
      .then(work)
      .catch((error: unknown) => this.logger.warn(`${label} failed (${errorCode(error)})`))
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }

  /** Resolves once every task started so far (and the ones they start) has ended. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.idle();
  }
}

/** The code of an error for a log line: an `InteractionError` code or the error's class name, never its message. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') return (error as { code: string }).code.slice(0, 64);
  return error instanceof Error ? error.name : 'error';
}

type Listener<T> = (value: T) => void | Promise<void>;

/**
 * Signals between parts of the module that must not depend on each other (the channel service and the Telegram fleet,
 * the link service and the notices): a listener error is logged, never propagated.
 */
@Injectable()
export class InteractionSignals {
  private readonly logger = new Logger('InteractionSignals');
  private readonly channelListeners = new Set<Listener<{ userId: number; kind: string }>>();
  private readonly linkListeners = new Set<Listener<{ userId: number; botRef: string }>>();

  onChannelsChanged(listener: Listener<{ userId: number; kind: string }>): () => void {
    this.channelListeners.add(listener);
    return () => this.channelListeners.delete(listener);
  }

  onTelegramLinked(listener: Listener<{ userId: number; botRef: string }>): () => void {
    this.linkListeners.add(listener);
    return () => this.linkListeners.delete(listener);
  }

  async channelsChanged(userId: number, kind: string): Promise<void> {
    await this.emit(this.channelListeners, { userId, kind });
  }

  async telegramLinked(userId: number, botRef: string): Promise<void> {
    await this.emit(this.linkListeners, { userId, botRef });
  }

  private async emit<T>(listeners: Set<Listener<T>>, value: T): Promise<void> {
    for (const listener of [...listeners]) {
      try {
        await listener(value);
      } catch (error) {
        this.logger.warn(`listener failed (${errorCode(error)})`);
      }
    }
  }
}

/** `InteractionHooks.registerRenderHook` (04 §4.7): an app rewrites a rendered message per channel (previews…). */
@Injectable()
export class InteractionHooks {
  private readonly hooks: InteractionRenderHook[] = [];

  registerRenderHook(hook: InteractionRenderHook): () => void {
    this.hooks.push(hook);
    return () => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    };
  }

  /** The message through every hook, in order; a hook that throws is skipped. */
  apply(kind: string, message: RenderedMessage): RenderedMessage {
    let current = message;
    for (const hook of this.hooks) {
      try {
        current = hook({ kind, message: current });
      } catch {
        /* a broken hook never blocks a delivery */
      }
    }
    return current;
  }
}
