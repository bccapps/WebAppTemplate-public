/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Body, Controller, Get, Post, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DecryptPayloadDto } from '../dtos/DecryptPayloadDto';
import { ApiTags } from '@nestjs/swagger';
import { CryptSessionService } from '../services/CryptSessionService';
import { CryptService } from '../services/CryptService';
import { CreateSessionDto } from '../dtos/CreateSessionDto';
import { Public } from '../decorators/Public';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';

/**
 * Budget of the anonymous transport handshake (an ECDH computation and a stored session each): a browser opens one per
 * page load and renews it when it expires; several users behind one NAT share it.
 */
export const CRYPT_SESSION_THROTTLE = { limit: 30, ttl: 60_000 };

/**
 * Transport-encryption handshake (public) and the admin decryption tool. `@Public()` is set per route, never on the
 * class: `admin/decrypt` must go through the global auth interceptor so that `AdminOnlyInterceptor` sees `req.user`.
 */
@ApiTags('crypt')
@Controller('/api/v1/crypt')
export class CryptController {
  constructor(
    private readonly cryptSessionService: CryptSessionService,
    private readonly cryptService: CryptService,
  ) {}

  @Public()
  @Get('public-key')
  getPublicKey() {
    return {
      publicKey: this.cryptSessionService.getServerPublicKey(),
      ttlMs: this.cryptSessionService.getSessionTtlMs(),
    };
  }

  @Public()
  @Throttle({ default: CRYPT_SESSION_THROTTLE })
  @Post('session')
  async createSession(@Body() body: CreateSessionDto) {
    if (!body?.clientPublicKey || typeof body.clientPublicKey !== 'string') {
      throw new BadRequestException('clientPublicKey is required');
    }
    let result: Awaited<ReturnType<CryptSessionService['createSession']>>;
    try {
      result = await this.cryptSessionService.createSession(body.clientPublicKey);
    } catch {
      // Storage failures fail open inside the service: what reaches here is a malformed key or an invalid curve point.
      throw new BadRequestException('clientPublicKey must be an uncompressed P-256 public key');
    }
    return {
      ...result,
      ttlMs: this.cryptSessionService.getSessionTtlMs(),
    };
  }

  @Post('admin/decrypt')
  @UseInterceptors(AdminOnlyInterceptor)
  decrypt(@Body() body: DecryptPayloadDto) {
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
