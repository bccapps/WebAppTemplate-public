/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { AUTH_PORT, type AuthPort } from '../../common/auth/AuthPort';
import { AppException } from '../../common/exceptions/AppException';
import type { IssueReportCreatedDto } from '../dtos/IssueReportCreatedDto';
import type { IssueReportDto } from '../dtos/IssueReportDto';
import { IssueReportEntity } from '../entities/IssueReportEntity';
import { IssueReportInputError, normalizeIssueReportInput, normalizeUserAgent } from '../issueReportInput';
import { ISSUE_REPORT_APP_VERSION_MAX, ISSUE_REPORTS_MINE_LIMIT, ISSUE_REPORTS_PER_USER_PER_HOUR } from '../issueReportTypes';
import { toIssueReportDto } from '../mappers/IssueReportMapper';
import { IssueHubClient, type IssueHubFailure } from './IssueHubClient';

const HOUR_MS = 60 * 60 * 1000;

/** HTTP answer of each relay failure: the hub's refusals stay visible to the reporter, the rest is a gateway error. */
export function relayFailure(reason: IssueHubFailure): AppException {
  if (reason === 'rejected') return new AppException('IRP_INVALID', 'The issue hub refused the report', HttpStatus.BAD_REQUEST);
  if (reason === 'rate_limited') return new AppException('IRP_RATE', 'Too many issue reports, try again later', HttpStatus.TOO_MANY_REQUESTS);
  return new AppException('IRP_HUB', 'The issue hub is not reachable', HttpStatus.BAD_GATEWAY);
}

/** Creates reports (validation, per-user budget, relay to the hub, local row) and lists a user's reports. */
@Injectable()
export class IssueReportService {
  private readonly logger = new Logger(IssueReportService.name);

  constructor(
    @InjectRepository(IssueReportEntity)
    private readonly repo: Repository<IssueReportEntity>,
    private readonly hub: IssueHubClient,
    @Optional() @Inject(AUTH_PORT) private readonly authPort?: AuthPort | null,
  ) {}

  /**
   * True when the hub is configured and the app has user accounts (reports come from signed-in users only). Without
   * an auth port (app wiring its own auth) the per-route `RequireUserInterceptor` remains the gate.
   */
  isEnabled(): boolean {
    return this.hub.isConfigured() && (this.authPort ? this.authPort.mode === 'users' : true);
  }

  /**
   * Relays a report of the signed-in `principalId` to the hub and keeps a row to follow it.
   * `503` not configured, `400` invalid field or refused by the hub, `429` budget spent, `502` hub unreachable.
   */
  async create(principalId: number, body: unknown, userAgentHeader: unknown): Promise<IssueReportCreatedDto> {
    if (!this.isEnabled()) throw new AppException('IRP_OFF', 'Issue reporting is not configured', HttpStatus.SERVICE_UNAVAILABLE);
    const input = this.validate(body);
    const userId = String(principalId);
    const recent = await this.repo.count({ where: { userId, createdAt: MoreThan(new Date(Date.now() - HOUR_MS)) } });
    if (recent >= ISSUE_REPORTS_PER_USER_PER_HOUR) throw relayFailure('rate_limited');

    const appVersion = process.env.APP_VERSION?.trim() || input.appVersion;
    const userAgent = normalizeUserAgent(userAgentHeader);
    const result = await this.hub.createIssue({
      title: input.title,
      body: input.description,
      reporterRef: userId,
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      ...(appVersion ? { appVersion: appVersion.slice(0, ISSUE_REPORT_APP_VERSION_MAX) } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
    // `=== false`, not `!result.ok`: the back compiles with `strict: false`, where only a literal comparison narrows.
    if (result.ok === false) throw relayFailure(result.reason);

    await this.remember(userId, result.number, input.title);
    return { number: result.number };
  }

  /** The user's reports, newest first (at most `ISSUE_REPORTS_MINE_LIMIT`). */
  async mine(principalId: number): Promise<IssueReportDto[]> {
    const rows = await this.repo.find({
      where: { userId: String(principalId) },
      order: { createdAt: 'DESC' },
      take: ISSUE_REPORTS_MINE_LIMIT,
    });
    return rows.map(toIssueReportDto);
  }

  private validate(body: unknown) {
    try {
      return normalizeIssueReportInput(body);
    } catch (error) {
      if (error instanceof IssueReportInputError) {
        throw new AppException('IRP_INVALID', `Invalid issue report field: ${error.field}`, HttpStatus.BAD_REQUEST);
      }
      throw error;
    }
  }

  /**
   * The issue exists on the hub from here on: a failed local write is logged, not surfaced (the reporter would retry
   * and file it twice); only the closure e-mail is lost for that report.
   */
  private async remember(userId: string, hubNumber: number, title: string): Promise<void> {
    try {
      await this.repo.save(this.repo.create({ userId, hubNumber, title, status: 'open', closedReason: null, closedAt: null, notifiedAt: null }));
    } catch (error) {
      this.logger.error(`Issue #${hubNumber} was created on the hub but could not be saved locally: ${(error as Error).message}`);
    }
  }
}
