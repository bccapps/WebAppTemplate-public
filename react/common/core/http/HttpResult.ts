/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

type CbFunction = (obj: any | null) => void;

export class HttpResult {
  thenCb: CbFunction | null = null;
  failCb: CbFunction | null = null;
  errorCb: CbFunction | null = null;
  notAuthorizedCb: CbFunction | null = null;

  then = (cb: CbFunction) => {
    this.thenCb = (obj: any | null) => {
      try {
        cb(obj);
      } catch (err: any) {
        console.log('EXCEPTION in HttpResult.then() : ', err);
      }
    };
    return this;
  };
  fail = (cb: CbFunction) => {
    this.failCb = cb;
    return this;
  };
  error = (cb: CbFunction) => {
    this.errorCb = cb;
    return this;
  };
  notAuthorized = (cb: CbFunction) => {
    this.notAuthorizedCb = cb;
    return this;
  };
}
