/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { throttledFetchJson } from '../../common/utils/throttledFetch';
import {
  ISSUE_HUB_STATUS_BATCH,
  ISSUE_REPORT_CLOSED_REASONS,
  type HubIssueStatus,
  type IssueReportClosedReason,
} from '../issueReportTypes';

/** Where the hub's intake lives and the project's secret. Read from the environment only, never sent to the browser. */
export interface IssueHubConfig {
  /** `ISSUE_HUB_URL` without trailing slash, e.g. `https://hub.example.com/api/v1/issue-intake`. */
  baseUrl: string;
  token: string;
}

export interface IssueHubConfigReading {
  config: IssueHubConfig | null;
  /** Why a value that is set is refused (never contains the token). `null` when both are unset or valid. */
  problem: string | null;
}

/** Body of `POST <ISSUE_HUB_URL>/issues` (hub contract). */
export interface IssueHubCreatePayload {
  title: string;
  body: string;
  reporterRef: string;
  pageUrl?: string;
  appVersion?: string;
  userAgent?: string;
}

export type IssueHubFailure = 'rejected' | 'rate_limited' | 'unauthorized' | 'unavailable';
export type IssueHubCreateResult = { ok: true; number: number } | { ok: false; reason: IssueHubFailure };

const TOKEN_PATTERN = /^[\x21-\x7E]{8,512}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CREATE_SOURCE = 'issue-hub';
const STATUS_SOURCE = 'issue-hub-status';
const TIMEOUT_MS = 10_000;

/** Pure reading of `ISSUE_HUB_URL` / `ISSUE_HUB_TOKEN` (exported for tests). */
export function readIssueHubConfig(env: NodeJS.ProcessEnv = process.env): IssueHubConfigReading {
  const rawUrl = env.ISSUE_HUB_URL?.trim() ?? '';
  const token = env.ISSUE_HUB_TOKEN?.trim() ?? '';
  if (!rawUrl && !token) return { config: null, problem: null };
  if (!rawUrl || !token) return { config: null, problem: 'ISSUE_HUB_URL and ISSUE_HUB_TOKEN must both be set' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { config: null, problem: 'ISSUE_HUB_URL is not a valid URL' };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    return { config: null, problem: 'ISSUE_HUB_URL must be an http(s) URL without credentials, query or fragment' };
  }
  if (!TOKEN_PATTERN.test(token)) return { config: null, problem: 'ISSUE_HUB_TOKEN is malformed (8 to 512 printable characters, no blank)' };
  return { config: { baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), token }, problem: null };
}

function closedReasonOf(value: unknown): IssueReportClosedReason {
  return (ISSUE_REPORT_CLOSED_REASONS as readonly unknown[]).includes(value) ? (value as IssueReportClosedReason) : 'manual';
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Validates one entry of the hub's status answer; `null` drops it (unknown number, malformed entry). */
export function parseHubIssueStatus(entry: unknown, asked: ReadonlySet<number>): HubIssueStatus | null {
  if (!entry || typeof entry !== 'object') return null;
  const { number, status, closedReason, closedAt } = entry as Record<string, unknown>;
  if (typeof number !== 'number' || !asked.has(number)) return null;
  if (status === 'open') return { number, status, closedReason: null, closedAt: null };
  if (status !== 'closed') return null;
  return { number, status, closedReason: closedReasonOf(closedReason), closedAt: dateOrNull(closedAt) };
}

/**
 * Relay to the Agent Hub intake (`POST …/issues`, `GET …/issues/status`) through `throttledFetch`, with
 * `Authorization: Bearer ISSUE_HUB_TOKEN`. Never throws; the token never appears in a log line or a result.
 */
@Injectable()
export class IssueHubClient {
  private readonly logger = new Logger(IssueHubClient.name);
  private readonly warned = new Set<string>();
  private cachedKey: string | null = null;
  private cached: IssueHubConfig | null = null;

  /** Current configuration (re-read when the environment changes), `null` when the module is off. */
  config(): IssueHubConfig | null {
    const key = `${process.env.ISSUE_HUB_URL ?? ''}\u0000${process.env.ISSUE_HUB_TOKEN ?? ''}`;
    if (key === this.cachedKey) return this.cached;
    const { config, problem } = readIssueHubConfig(process.env);
    if (problem) this.warnOnce(problem, `Issue reporting is off: ${problem}`);
    if (config && config.baseUrl.startsWith('http:') && !LOOPBACK_HOSTS.has(new URL(config.baseUrl).hostname)) {
      this.warnOnce('plain-http', 'ISSUE_HUB_URL uses plain http on a non-local host: the token travels unencrypted, use https');
    }
    this.cachedKey = key;
    this.cached = config;
    return config;
  }

  isConfigured(): boolean {
    return this.config() !== null;
  }

  /** Creates the issue on the hub. One attempt only: a retried POST could file the same report twice. */
  async createIssue(payload: IssueHubCreatePayload): Promise<IssueHubCreateResult> {
    const config = this.config();
    if (!config) return { ok: false, reason: 'unavailable' };
    const result = await throttledFetchJson<{ number?: unknown }>(CREATE_SOURCE, `${config.baseUrl}/issues`, {
      timeoutMs: TIMEOUT_MS,
      maxRetries: 0,
      init: { method: 'POST', headers: this.headers(config, true), body: JSON.stringify(payload) },
    });
    const number = result.data?.number;
    if (!result.stale && typeof number === 'number' && Number.isInteger(number) && number > 0) return { ok: true, number };
    return { ok: false, reason: this.failureOf(result.status, result.stale) };
  }

  /**
   * States of the given hub numbers (at most `ISSUE_HUB_STATUS_BATCH`); `null` when the hub could not be read,
   * so the caller keeps its reports as they are and tries again on the next run.
   */
  async statusOf(numbers: number[]): Promise<HubIssueStatus[] | null> {
    const config = this.config();
    const asked = new Set(numbers.filter((n) => Number.isInteger(n) && n > 0).slice(0, ISSUE_HUB_STATUS_BATCH));
    if (!config || asked.size === 0) return config ? [] : null;
    const result = await throttledFetchJson<{ issues?: unknown }>(STATUS_SOURCE, `${config.baseUrl}/issues/status?numbers=${[...asked].join(',')}`, {
      timeoutMs: TIMEOUT_MS,
      maxRetries: 2,
      minIntervalMs: 1_000,
      init: { headers: this.headers(config, false) },
    });
    const issues = result.data?.issues;
    if (result.stale || !Array.isArray(issues)) {
      if (result.stale) this.failureOf(result.status, true);
      else this.logger.warn('Issue hub status answer is malformed');
      return null;
    }
    return issues.map((entry) => parseHubIssueStatus(entry, asked)).filter((entry): entry is HubIssueStatus => entry !== null);
  }

  private headers(config: IssueHubConfig, json: boolean): Record<string, string> {
    return { Authorization: `Bearer ${config.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  private failureOf(status: number, stale: boolean): IssueHubFailure {
    if (status === 400) return 'rejected';
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) {
      this.warnOnce('unauthorized', `Issue hub refused the token (HTTP ${status}): check ISSUE_HUB_TOKEN and that the project's intake is enabled`);
      return 'unauthorized';
    }
    if (!stale) this.logger.warn('Issue hub answered without an issue number');
    return 'unavailable';
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
