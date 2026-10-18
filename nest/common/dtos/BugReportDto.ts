/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /api/v1/common/bug-report`. The reporter's id comes from the session, never from the body. */
export class BugReportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  description!: string;

  /** Reply-to address (may be empty for an account without email). */
  @IsString()
  @MaxLength(320)
  email!: string;
}
