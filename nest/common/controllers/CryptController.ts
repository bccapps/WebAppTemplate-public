/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Body, Controller, Get, Post, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CryptSessionService } from '../services/CryptSessionService';
import { CryptService } from '../services/CryptService';
import { CreateSessionDto } from '../dtos/CreateSessionDto';
import { Public } from '../decorators/Public';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';

@Public()
@ApiTags('crypt')
@Controller('/api/v1/crypt')
export class CryptController {
  constructor(
    private readonly cryptSessionService: CryptSessionService,
    private readonly cryptService: CryptService,
  ) {}

  @Get('public-key')
  getPublicKey() {
    return {
      publicKey: this.cryptSessionService.getServerPublicKey(),
      ttlMs: this.cryptSessionService.getSessionTtlMs(),
    };
  }

  @Post('session')
  async createSession(@Body() body: CreateSessionDto) {
    if (!body?.clientPublicKey || typeof body.clientPublicKey !== 'string') {
      throw new BadRequestException('clientPublicKey is required');
    }
    const result = await this.cryptSessionService.createSession(body.clientPublicKey);
    return {
      ...result,
      ttlMs: this.cryptSessionService.getSessionTtlMs(),
    };
  }

  @Post('admin/decrypt')
  @UseInterceptors(AdminOnlyInterceptor)
  decrypt(@Body() body: { payload: string; namespace?: string }) {
    if (!body?.payload || typeof body.payload !== 'string') {
      throw new BadRequestException('payload is required');
    }
    try {
      const value = this.cryptService.decryptFromStorage(body.payload, body.namespace ?? 'default');
      return { value };
    } catch {
      throw new BadRequestException('Decryption failed — invalid payload or namespace');
    }
  }
}
