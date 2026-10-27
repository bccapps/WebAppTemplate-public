/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { authUserId } from '../../common/auth/authRequest';
import { RequireUserInterceptor } from '../../common/auth/RequireUserInterceptor';
import { Public } from '../../common/decorators/Public';
import { CreateIssueReportDto } from '../dtos/CreateIssueReportDto';
import type { IssueReportConfigDto } from '../dtos/IssueReportConfigDto';
import type { IssueReportCreatedDto } from '../dtos/IssueReportCreatedDto';
import type { IssueReportDto } from '../dtos/IssueReportDto';
import { IssueReportService } from '../services/IssueReportService';

@ApiTags('issue-report')
@Controller('/api/v1/issue-reports')
export class IssueReportController {
  constructor(private readonly reports: IssueReportService) {}

  /** Whether the report button is offered. Public: the answer says nothing about the hub. */
  @Public()
  @Get('config')
  config(): IssueReportConfigDto {
    return { enabled: this.reports.isEnabled() };
  }

  /** Signed-in users only; the reporter is the session's principal, never a value of the body. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(RequireUserInterceptor)
  create(@Body() body: CreateIssueReportDto, @Req() req: Request): Promise<IssueReportCreatedDto> {
    return this.reports.create(authUserId(req), body, req.headers['user-agent']);
  }

  @Get('mine')
  @UseInterceptors(RequireUserInterceptor)
  mine(@Req() req: Request): Promise<IssueReportDto[]> {
    return this.reports.mine(authUserId(req));
  }
}
