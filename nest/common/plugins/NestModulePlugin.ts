/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { DynamicModule, Type } from '@nestjs/common';
import type { AuthCoreOptions } from '../auth/AuthCoreModule';

/** Descriptor exported as `plugin` by `<module>/plugin.ts`, consumed by the generated plugins file of the app. */
export interface NestModulePlugin {
  id: string;
  /** Module(s) to add to AppModule.imports. */
  module?: Type<unknown> | DynamicModule;
  /** At most one linked plugin may provide auth; it replaces the anonymous provider. */
  auth?: AuthCoreOptions;
}
