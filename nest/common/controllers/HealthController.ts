/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../decorators/Public';
import { NoTransportCrypt } from '../decorators/NoTransportCrypt';
import {
  HEALTH_CONTRIBUTORS,
  HealthContribution,
  HealthContributor,
  HealthState,
} from '../types/ExtensionPoints';

/** Longest a contributor may take before it counts as `down`. */
export const HEALTH_CONTRIBUTOR_TIMEOUT_MS = 3000;

export interface HealthResponse {
  status: HealthState;
  timestamp: string;
  uptime: number;
  version: string;
  /** Deployed revision (`DEPLOY_REVISION`, set by scripts/deploy-full.sh); null when the back was not deployed by it. */
  revision: string | null;
  checks: Record<string, HealthContribution>;
}

/** Public liveness endpoint used by Docker/compose healthchecks and external probes. */
@ApiTags('health')
@Controller('/api/v1/health')
@NoTransportCrypt()
export class HealthController {
  private readonly contributors: HealthContributor[];

  constructor(@Optional() @Inject(HEALTH_CONTRIBUTORS) contributors?: HealthContributor | HealthContributor[]) {
    this.contributors = contributors ? ([] as HealthContributor[]).concat(contributors) : [];
  }

  @Get()
  @Public()
  @ApiOkResponse({ description: 'Process liveness plus the contribution of every registered health contributor' })
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const entries = await Promise.all(this.contributors.map(async (c) => [c.key, await this.probe(c)] as const));
    const checks = Object.fromEntries(entries);
    const status = aggregate(entries.map(([, c]) => c.status));
    if (status === 'down') res.status(503);
    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? 'unknown',
      revision: process.env.DEPLOY_REVISION ?? null,
      checks,
    };
  }

  private async probe(contributor: HealthContributor): Promise<HealthContribution> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HealthContribution>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'down', error: 'timeout' }), HEALTH_CONTRIBUTOR_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => contributor.check()), timeout]);
    } catch (err) {
      return { status: 'down', error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function aggregate(states: HealthState[]): HealthState {
  if (states.includes('down')) return 'down';
  return states.includes('degraded') ? 'degraded' : 'ok';
}
