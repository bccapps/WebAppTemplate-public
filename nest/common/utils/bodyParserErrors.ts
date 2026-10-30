/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** A request body the client got wrong, as reported by `body-parser`. */
export interface BodyParserErrorInfo {
  /** 4xx status (413 too large, 400 malformed JSON or aborted, 415 unsupported charset/encoding…). */
  status: number;
  /** `body-parser` error type (`entity.too.large`, `entity.parse.failed`, `charset.unsupported`…). */
  type: string;
}

/** Request property set by {@link tagBodyParserErrors}: Nest turns a malformed-JSON `SyntaxError` into a plain `BadRequestException`. */
export const BODY_PARSER_ERROR = Symbol.for('vx.common.bodyParserError');

const BODY_PARSER_TYPE = /^(entity|request|charset|encoding|parameters|querystring)\.[a-zA-Z.]+$/;

/** The client-caused `body-parser` error carried by `err` (http-errors: 4xx `status` + `type`), or null. */
export function bodyParserErrorInfo(err: unknown): BodyParserErrorInfo | null {
  const candidate = (err ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  const { type } = candidate;
  if (typeof status !== 'number' || status < 400 || status > 499 || typeof type !== 'string') return null;
  return BODY_PARSER_TYPE.test(type) ? { status, type } : null;
}

/** The body-parser error recorded on the request by {@link tagBodyParserErrors}, or null. */
export function bodyParserErrorOf(req: unknown): BodyParserErrorInfo | null {
  const tagged = (req as Record<symbol, unknown> | null | undefined)?.[BODY_PARSER_ERROR];
  return tagged ? (tagged as BodyParserErrorInfo) : null;
}

/**
 * Express error middleware placed right after the body parsers (`configureHttpApp`): records a client-caused body-parser
 * error on the request, then hands the error on unchanged (the global exception filter answers and logs it).
 */
export function tagBodyParserErrors(err: unknown, req: object, _res: unknown, next: (err?: unknown) => void): void {
  const info = bodyParserErrorInfo(err);
  if (info) (req as Record<symbol, unknown>)[BODY_PARSER_ERROR] = info;
  next(err);
}
