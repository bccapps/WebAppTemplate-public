/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { assertProductionEnvironment } from './CrossEnvDbConnection';

describe('assertProductionEnvironment — garde-fou prod-only des actions de publication cross-env', () => {
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  it('ne lève rien quand APP_ENV vaut "prod"', () => {
    process.env.APP_ENV = 'prod';
    expect(() => assertProductionEnvironment()).not.toThrow();
  });

  it('lève une BadRequestException pour preprod', () => {
    process.env.APP_ENV = 'preprod';
    expect(() => assertProductionEnvironment()).toThrow(BadRequestException);
  });

  it('lève une BadRequestException pour dev', () => {
    process.env.APP_ENV = 'dev';
    expect(() => assertProductionEnvironment()).toThrow(BadRequestException);
  });

  it('lève une BadRequestException quand APP_ENV est absent', () => {
    delete process.env.APP_ENV;
    expect(() => assertProductionEnvironment()).toThrow(BadRequestException);
  });
});
