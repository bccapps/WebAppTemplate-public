/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, Max } from 'class-validator';
import { ValidateOnlyPipe } from './ValidateOnlyPipe';

class QueryDto {
  @Type(() => Number)
  @IsInt()
  @Max(10)
  page!: number;
}

class BodyDto {
  @IsString()
  name!: string;
}

describe('ValidateOnlyPipe', () => {
  const pipe = new ValidateOnlyPipe();

  it('returns the very same request object (uid/user kept, query strings not converted)', async () => {
    const body = { name: 'x', uid: 3, user: { id: 3 } };
    await expect(pipe.transform(body, { type: 'body', metatype: BodyDto })).resolves.toBe(body);
    const query = { page: '2' };
    await expect(pipe.transform(query, { type: 'query', metatype: QueryDto })).resolves.toBe(query);
    expect(query.page).toBe('2');
  });

  it('still rejects an invalid DTO', async () => {
    await expect(pipe.transform({ name: 1 }, { type: 'body', metatype: BodyDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ page: '11' }, { type: 'query', metatype: QueryDto })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves primitives and untyped params alone', async () => {
    await expect(pipe.transform('12', { type: 'param', metatype: Number, data: 'id' })).resolves.toBe('12');
    await expect(pipe.transform({ any: 1 }, { type: 'body', metatype: Object })).resolves.toEqual({ any: 1 });
  });
});
