/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

/**
 * Global pipe of `configureHttpApp({ validation: { validateOnly: true } })`: validates a class-typed `@Body()` /
 * `@Query()` / `@Param()` against its class-validator decorators (400 on failure) and hands the handler the request
 * value **untouched** — no whitelist (the `uid`/`user` the auth interceptors write into the body survive), no
 * transformation (no class instance, no implicit conversion of primitives, no `instanceToPlain`). Interfaces, inline
 * types and primitives (`@Body('field')`) are not validated, exactly like the stock `ValidationPipe`. A route-scoped
 * `ValidationPipe({ whitelist, transform })` still runs after it and keeps its own behaviour.
 */
export class ValidateOnlyPipe extends ValidationPipe {
  constructor() {
    super({ whitelist: false, forbidNonWhitelisted: false, transform: false });
  }

  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    await super.transform(value, metadata);
    return value;
  }
}
