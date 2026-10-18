/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { TestEmailDto } from '../dtos/TestEmailDto';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { EmailService, SendEmailResult } from '../services/EmailService';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';

@ApiTags('email')
@UseInterceptors(AdminOnlyInterceptor)
@Controller()
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @ApiOkResponse({ description: 'Send a test email to verify configuration' })
  @Post('/api/v1/admin/email/test')
  async sendTestEmail(@Body() body: TestEmailDto): Promise<SendEmailResult> {
    return this.emailService.sendTestEmail(body.to);
  }
}
