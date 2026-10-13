/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { resolveSwaggerEnabled } from './swaggerEnabled';

describe('resolveSwaggerEnabled', () => {
  it('is on outside production and off in production by default', () => {
    expect(resolveSwaggerEnabled({})).toBe(true);
    expect(resolveSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(resolveSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  it('lets SWAGGER_ENABLED win in both directions', () => {
    expect(resolveSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(true);
    expect(resolveSwaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: ' FALSE ' })).toBe(false);
  });

  it('ignores an unrecognised SWAGGER_ENABLED value', () => {
    expect(resolveSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'yes' })).toBe(false);
  });
});
