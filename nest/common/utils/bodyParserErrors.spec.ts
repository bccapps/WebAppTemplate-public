/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { BODY_PARSER_ERROR, bodyParserErrorInfo, bodyParserErrorOf, tagBodyParserErrors } from './bodyParserErrors';

const httpError = (status: number, type?: string) => Object.assign(new Error('x'), { status, statusCode: status, expose: true, type });

describe('bodyParserErrorInfo', () => {
  it.each([
    [413, 'entity.too.large'],
    [400, 'entity.parse.failed'],
    [415, 'charset.unsupported'],
    [415, 'encoding.unsupported'],
    [400, 'request.aborted'],
    [413, 'parameters.too.many'],
    [400, 'querystring.parse.rangeError'],
  ])('recognizes %p %p', (status, type) => {
    expect(bodyParserErrorInfo(httpError(status, type))).toEqual({ status, type });
  });

  it('ignores server errors, untyped errors and foreign types', () => {
    expect(bodyParserErrorInfo(httpError(500, 'stream.not.readable'))).toBeNull();
    expect(bodyParserErrorInfo(httpError(404))).toBeNull();
    expect(bodyParserErrorInfo(httpError(400, 'custom'))).toBeNull();
    expect(bodyParserErrorInfo(new Error('boom'))).toBeNull();
    expect(bodyParserErrorInfo(null)).toBeNull();
  });
});

describe('tagBodyParserErrors', () => {
  it('records a client body error on the request and forwards the same error', () => {
    const req = {};
    const next = jest.fn();
    const err = httpError(400, 'entity.parse.failed');
    tagBodyParserErrors(err, req, {}, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(bodyParserErrorOf(req)).toEqual({ status: 400, type: 'entity.parse.failed' });
    expect((req as Record<symbol, unknown>)[BODY_PARSER_ERROR]).toBeDefined();
  });

  it('leaves the request untouched for any other error', () => {
    const req = {};
    const next = jest.fn();
    const err = new Error('boom');
    tagBodyParserErrors(err, req, {}, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(bodyParserErrorOf(req)).toBeNull();
    expect(tagBodyParserErrors.length).toBe(4);
  });
});
