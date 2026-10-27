/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../common/CommonModule';
import { IssueReportController } from './controllers/IssueReportController';
import { IssueReportEntity } from './entities/IssueReportEntity';
import { IssueHubClient } from './services/IssueHubClient';
import { IssueReportNotificationService } from './services/IssueReportNotificationService';
import { IssueReportService } from './services/IssueReportService';
import { IssueReportStatusService } from './services/IssueReportStatusService';

/**
 * Problem reports of signed-in users, relayed to an Agent Hub project. No `ScheduleModule.forRoot()` here: the app
 * registers it once (a second registration fires every `@Cron` twice). `USER_CONTACT` comes from `user` when linked.
 */
@Module({
  imports: [CommonModule, TypeOrmModule.forFeature([IssueReportEntity])],
  controllers: [IssueReportController],
  providers: [IssueHubClient, IssueReportService, IssueReportNotificationService, IssueReportStatusService],
  exports: [IssueReportService],
})
export class IssueReportModule {}
