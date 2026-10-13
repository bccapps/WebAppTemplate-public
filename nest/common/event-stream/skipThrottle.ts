/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Logger } from '@nestjs/common';

/**
 * Class decorator: applies `@SkipThrottle()` of `@nestjs/throttler` when that package is installed, does nothing
 * otherwise (`common` does not depend on it). A reconnecting stream would otherwise count against the rate limit.
 * Plumbing point for D1, which moves the limiter into `common`: no change needed here once it is a dependency.
 */
export function SkipThrottleIfAvailable(): ClassDecorator {
  return (target) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SkipThrottle } = require('@nestjs/throttler') as { SkipThrottle: () => ClassDecorator };
      SkipThrottle()(target);
    } catch {
      new Logger('EventStream').debug('@nestjs/throttler not installed: no rate-limit exemption needed');
    }
  };
}
