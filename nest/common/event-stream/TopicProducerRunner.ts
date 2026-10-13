/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';
import type { StreamEventInput, TopicMatch, TopicProducer } from './types';

interface Running {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

/** Runs one producer loop per concrete topic: `produce` is never called concurrently for the same topic. */
export class TopicProducerRunner {
  private readonly logger = new Logger(TopicProducerRunner.name);
  private readonly running = new Map<string, Running>();

  constructor(private readonly emit: (topic: string, event: StreamEventInput) => void) {}

  isRunning(topic: string): boolean {
    return this.running.has(topic);
  }

  start(match: TopicMatch, producer: TopicProducer): void {
    if (this.running.has(match.topic)) return;
    const state: Running = { timer: null, stopped: false };
    this.running.set(match.topic, state);
    void this.loop(match, producer, state);
  }

  stop(topic: string): void {
    const state = this.running.get(topic);
    if (!state) return;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    this.running.delete(topic);
  }

  stopAll(): void {
    for (const topic of [...this.running.keys()]) this.stop(topic);
  }

  private async loop(match: TopicMatch, producer: TopicProducer, state: Running): Promise<void> {
    try {
      const produced = await producer.produce(match);
      if (!state.stopped && produced) {
        for (const event of Array.isArray(produced) ? produced : [produced]) this.emit(match.topic, event);
      }
    } catch (err) {
      this.logger.warn(`producer for ${match.topic} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (state.stopped) return;
    state.timer = setTimeout(() => void this.loop(match, producer, state), producer.intervalMs);
    state.timer.unref();
  }
}
