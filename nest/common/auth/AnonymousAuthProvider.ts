/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { AuthPort } from './AuthPort';
import type { AuthPrincipal } from './AuthPrincipal';

const MIN_ADMIN_TOKEN_LENGTH = 32;

/**
 * Auth provider used when no user module is linked: the only identity is the
 * admin, authenticated by the ADMIN_TOKEN environment variable.
 */
@Injectable()
export class AnonymousAuthProvider implements AuthPort {
  readonly mode = 'anonymous' as const;
  private readonly logger = new Logger(AnonymousAuthProvider.name);
  private readonly expected: Buffer | null;

  constructor() {
    const token = process.env.ADMIN_TOKEN ?? '';
    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
      this.expected = null;
      this.logger.warn(
        `ADMIN_TOKEN is missing or shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters: admin access is disabled`,
      );
    } else {
      this.expected = Buffer.from(token, 'utf8');
    }
  }

  async resolveToken(token: string): Promise<AuthPrincipal | null> {
    if (!this.expected || !token) return null;
    const given = Buffer.from(token, 'utf8');
    if (given.length !== this.expected.length) return null;
    if (!timingSafeEqual(given, this.expected)) return null;
    return { id: 0, admin: true, kind: 'admin-token' };
  }
}
