/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsDefined, ValidateNested } from 'class-validator';

export class CookieConsentCategoriesDto {
  @Equals(true)
  necessary!: true;

  @IsBoolean()
  audienceMeasurement!: boolean;
}

/** Body of the public `POST /api/v1/cookie-consent` (proof-of-consent record). */
export class CookieConsentLogDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => CookieConsentCategoriesDto)
  categories!: CookieConsentCategoriesDto;
}
