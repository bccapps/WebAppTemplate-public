/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CookieConsentLogDto } from './CookieConsentLogDto';
import { BugReportDto } from './BugReportDto';
import { ThemeCreateDto } from './ThemeCreateDto';
import { TestEmailDto } from './TestEmailDto';
import { DecryptPayloadDto } from './DecryptPayloadDto';

// Same options as the default global pipe of configureHttpApp (whitelist + transform): what the payloads must survive.
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const validate = (metatype: new () => object, value: unknown) => pipe.transform(value, { type: 'body', metatype });

describe('common request DTOs', () => {
  it('accept what the shared front sends', async () => {
    await expect(validate(CookieConsentLogDto, { categories: { necessary: true, audienceMeasurement: false } })).resolves.toBeDefined();
    await expect(validate(BugReportDto, { subject: 's', description: 'd', email: '' })).resolves.toEqual({ subject: 's', description: 'd', email: '' });
    await expect(validate(ThemeCreateDto, { name: 'Dark', description: '' })).resolves.toBeDefined();
    await expect(validate(TestEmailDto, { to: 'a@b.io' })).resolves.toBeDefined();
    await expect(validate(DecryptPayloadDto, { payload: 'enc:v1:abc' })).resolves.toBeDefined();
  });

  it.each([
    [CookieConsentLogDto, { categories: { necessary: false, audienceMeasurement: true } }],
    [CookieConsentLogDto, { categories: 'all' }],
    [BugReportDto, { subject: 'x'.repeat(301), description: 'd', email: '' }],
    [ThemeCreateDto, { name: '', description: 'd' }],
    [DecryptPayloadDto, { payload: '' }],
  ])('rejects an invalid %p body', async (metatype, body) => {
    await expect(validate(metatype as new () => object, body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
