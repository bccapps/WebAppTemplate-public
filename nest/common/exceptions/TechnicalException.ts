/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpStatus } from '@nestjs/common';
import { AppException } from './AppException';

export class TechnicalException extends AppException {
  constructor(code: string, message: string) {
    super(code, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
