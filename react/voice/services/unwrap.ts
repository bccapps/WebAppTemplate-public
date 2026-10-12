/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { HttpResult } from '../../common/core/http/HttpResult';

/**
 * Wraps an HttpResult so its `.then()` callback receives `response.data`
 * instead of the full `{ data: ... }` envelope returned by the backend.
 */
export function unwrap(result: HttpResult): HttpResult {
  const originalThen = result.then;
  result.then = (cb) => {
    return originalThen.call(result, (raw: any) => {
      cb(raw?.data !== undefined ? raw.data : raw);
    });
  };
  return result;
}
