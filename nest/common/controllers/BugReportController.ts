/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { BugReportDto } from '../dtos/BugReportDto';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { EmailService } from '../services/EmailService';
import { ModuleConfigService } from '../services/ModuleConfigService';
import { FunctionalException } from '../exceptions/FunctionalException';

/** Budget of bug reports (each one sends an email; reachable without a token when the app runs in anonymous mode). */
export const BUG_REPORT_THROTTLE = { limit: 5, ttl: 3_600_000 };

/** The report fields are user input embedded in an HTML email: escaped so they cannot inject markup or links. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

@ApiTags('bug-report')
@Controller()
export class BugReportController {
  constructor(
    private readonly emailService: EmailService,
    private readonly moduleConfigService: ModuleConfigService,
  ) {}

  @ApiOkResponse({ description: 'Send a bug report email' })
  @Throttle({ default: BUG_REPORT_THROTTLE })
  @Post('/api/v1/common/bug-report')
  async sendBugReport(
    @Body() body: BugReportDto,
    @Req() request: Request,
  ): Promise<{ success: boolean }> {
    const uid = (request as Request & { user?: { id?: number } }).user?.id;
    const recipientEmail = String(
      this.moduleConfigService.getDecryptedValue('common_bugReport_recipientEmail') ?? '',
    );
    if (!recipientEmail) {
      throw new FunctionalException('CFG', 'Bug report recipient email is not configured');
    }

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1fcb7d; border-bottom: 2px solid #1fcb7d; padding-bottom: 8px;">
          Bug Report
        </h2>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; vertical-align: top; width: 120px;">From</td>
            <td style="padding: 6px 12px;">${escapeHtml(body.email)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; vertical-align: top;">User ID</td>
            <td style="padding: 6px 12px;">${uid ?? 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px; font-weight: bold; vertical-align: top;">Subject</td>
            <td style="padding: 6px 12px;">${escapeHtml(body.subject)}</td>
          </tr>
        </table>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; margin-top: 12px;">
          <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(body.description)}</p>
        </div>
      </div>
    `;

    const result = await this.emailService.sendEmail(
      recipientEmail,
      `[Bug Report] ${body.subject}`,
      html,
      { replyTo: body.email },
    );

    return { success: result.success };
  }
}
