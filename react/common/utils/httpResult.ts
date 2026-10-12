/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpResult } from '../core/http/HttpResult';

export function httpResultToPromise<T = any>(result: HttpResult): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    result
      .then((data: T) => resolve(data as T))
      .fail((err: any) => reject(err))
      .error((err: any) => reject(err))
      .notAuthorized((err: any) => reject(err));
  });
}

export function runHttpResult<T = any>(factory: () => HttpResult): Promise<T> {
  try {
    const result = factory();
    return httpResultToPromise<T>(result);
  } catch (error) {
    return Promise.reject(error);
  }
}
