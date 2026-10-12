/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';

export type InstanceRole = 'worker' | 'api';

/**
 * Resolves the role of the current backend process from the `NODE_ROLE` env var.
 *
 * - `worker` (DEFAULT): runs all background work — schedulers (@Cron/@Interval), trading
 *   engines, run workers, feeds — owns runs and heartbeats to the WorkerRegistry. In a
 *   multi-instance deployment the worker is kept OUT of the load-balancer upstream so its
 *   compute never blocks API request serving.
 * - `api`: serves HTTP only. Skips all WORKER-ONLY scheduled/bootstrap work, never becomes a
 *   run owner (no heartbeat), but stays a fully-functional RPC client to the worker and keeps
 *   per-process concerns that the API needs (config cache warmup, in-memory market cache).
 *
 * The default is `worker` so that a single-instance deployment (local/dev) keeps doing
 * everything exactly as before, and a misconfigured prod (NODE_ROLE unset) degrades to the
 * current "every instance runs everything" behaviour rather than silently stopping all crons.
 *
 * Singleton/non-idempotent scheduled tasks must STILL guard with CronLockService: rolling
 * deploys briefly run two workers (old + new), so role gating alone does not guarantee
 * single execution.
 */
@Injectable()
export class InstanceRoleService {
  private readonly logger = new Logger(InstanceRoleService.name);
  private readonly _role: InstanceRole;

  constructor() {
    const raw = (process.env.NODE_ROLE || '').trim().toLowerCase();
    this._role = raw === 'api' ? 'api' : 'worker';
    if (raw && raw !== 'api' && raw !== 'worker') {
      this.logger.warn(`NODE_ROLE="${raw}" not recognised — defaulting to "worker".`);
    }
    this.logger.log(`Instance role: ${this._role}`);
  }

  get role(): InstanceRole {
    return this._role;
  }

  isWorker(): boolean {
    return this._role === 'worker';
  }

  isApi(): boolean {
    return this._role === 'api';
  }
}
