/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { AppException } from '../exceptions/AppException';

/** Codes of the principal-kind refusals of `RejectApiTokenInterceptor` / `RequireHumanSessionInterceptor`. */
export type PrincipalRefusalCode = 'API_TOKEN_NOT_ALLOWED' | 'HUMAN_SESSION_REQUIRED';

/**
 * 403 with ONE uniform coded body `{ statusCode: 403, code, message }` (the same raw body with or without the global
 * `AppExceptionFilter`, which also exposes `code` at the top level). The message never carries a token.
 */
export class PrincipalRefusedException extends AppException {
  constructor(code: PrincipalRefusalCode, message: string) {
    super(code, message, 403);
  }

  override getResponse(): { statusCode: number; code: string; message: string } {
    return { statusCode: 403, code: this.code, message: this.message };
  }
}
