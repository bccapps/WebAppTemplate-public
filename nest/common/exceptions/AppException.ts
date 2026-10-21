/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpException } from '@nestjs/common';

export class AppException extends HttpException {
  code: string;
  constructor(code: string, message: string, status: number) {
    super(message, status);
    this.code = code;
  }
}
