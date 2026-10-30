/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export { CommonThrottlerGuard } from './CommonThrottlerGuard';
export { FailOpenThrottlerStorage } from './FailOpenThrottlerStorage';
export { buildThrottlerOptions, throttleProviders } from './throttleProviders';
export { ThrottleRegistry, toThrottlerOptions } from './ThrottleRegistry';
export type { ThrottleIdentity, ThrottleRule, ThrottleTracker, ThrottleValue } from './ThrottleRegistry';
