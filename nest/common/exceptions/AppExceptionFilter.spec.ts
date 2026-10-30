/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AppExceptionFilter, BODY_ERROR_LOG_PER_MINUTE, CLIENT_ERROR_LOG_PER_MINUTE, httpErrorStatus } from './AppExceptionFilter';
import { BODY_PARSER_ERROR } from '../utils/bodyParserErrors';
import { SecurityException } from './SecurityException';
import { TechnicalException } from './TechnicalException';

type Req = Record<string | symbol, unknown>;

function run(exception: unknown, request: Req = { ip: '1.2.3.4', method: 'POST', url: '/x' }, filter?: AppExceptionFilter) {
  const notify = jest.fn();
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    headersSent: false,
    status: (code: number) => { sent.status = code; return response; },
    send: (body: Record<string, unknown>) => { sent.body = body; },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    getClass: () => ({ name: 'Svc' }),
    getHandler: () => ({ name: 'handler' }),
  };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (filter ?? new AppExceptionFilter({ safeNotify: notify } as never)).catch(exception, host as never);
  const logs = { warn: warn.mock.calls.map((c) => [...c]), error: error.mock.calls.map((c) => [...c]) };
  warn.mockRestore();
  error.mockRestore();
  return { sent, notify, logs };
}

const tooLarge = () => Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, expose: true, type: 'entity.too.large' });

describe('AppExceptionFilter — Express/body-parser client errors', () => {
  it('answers 413 for an oversized body and does not page the operator', () => {
    const { sent, notify } = run(Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, expose: true, type: 'entity.too.large' }));
    expect(sent.status).toBe(413);
    expect(sent.body?.message).toBe('request entity too large');
    expect(notify).not.toHaveBeenCalled();
  });

  it('answers 400 for malformed JSON without a notification', () => {
    const { sent, notify } = run(Object.assign(new SyntaxError('Unexpected token'), { status: 400, expose: true, type: 'entity.parse.failed' }));
    expect(sent.status).toBe(400);
    expect(notify).not.toHaveBeenCalled();
  });

  it('still answers 500 and notifies for a genuine unhandled error', () => {
    const { sent, notify } = run(new Error('boom'));
    expect(sent.status).toBe(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never trusts a non-client status', () => {
    expect(httpErrorStatus({ status: 500 })).toBeNull();
    expect(httpErrorStatus({ status: 302 })).toBeNull();
    expect(httpErrorStatus({ status: 404, expose: false })).toBeNull();
    expect(httpErrorStatus({ statusCode: 429 })).toBe(429);
    expect(httpErrorStatus(null)).toBeNull();
  });
});

describe('AppExceptionFilter — client body errors are logged as one rate-limited WARN line', () => {
  const request = (): Req => ({ ip: '203.0.113.9', method: 'POST', url: '/api/v1/x/webhook?token=secret', socket: {} });

  it('logs a 413 as one line with status, type, method, path (no query) and IP, no stack, no error object', () => {
    const { sent, logs } = run(tooLarge(), request());
    expect(sent.status).toBe(413);
    expect(logs.error).toEqual([]);
    expect(logs.warn).toEqual([
      ['[AppExceptionFilter] Client body error (413 entity.too.large) | ip=203.0.113.9 | endpoint=POST /api/v1/x/webhook'],
    ]);
  });

  it('recognizes malformed JSON through the request tag, keeping the 400 response shape of a BadRequestException', () => {
    const req = { ...request(), [BODY_PARSER_ERROR]: { status: 400, type: 'entity.parse.failed' } };
    const { sent, logs, notify } = run(new BadRequestException('Unexpected token } in JSON at position 5'), req);
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: 'ERR', statusCode: 400, message: 'Unexpected token } in JSON at position 5', details: { error: 'Bad Request' } });
    expect(logs.warn).toEqual([['[AppExceptionFilter] Client body error (400 entity.parse.failed) | ip=203.0.113.9 | endpoint=POST /api/v1/x/webhook']]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('logs a 415 charset error the same way', () => {
    const err = Object.assign(new Error('unsupported charset "X"'), { status: 415, expose: true, type: 'charset.unsupported' });
    const { sent, logs } = run(err, request());
    expect(sent.status).toBe(415);
    expect(logs.warn[0][0]).toContain('Client body error (415 charset.unsupported)');
  });

  it(`writes at most ${BODY_ERROR_LOG_PER_MINUTE} lines per category and per minute, whatever the caller sends`, () => {
    const filter = new AppExceptionFilter({ safeNotify: jest.fn() } as never);
    let lines = 0;
    for (let i = 0; i < 50; i += 1) lines += run(tooLarge(), request(), filter).logs.warn.length;
    expect(lines).toBe(BODY_ERROR_LOG_PER_MINUTE);
    const parse = { ...request(), [BODY_PARSER_ERROR]: { status: 400, type: 'entity.parse.failed' } };
    expect(run(new BadRequestException('bad'), parse, filter).logs.warn).toHaveLength(1);
    (filter as unknown as { bodyErrorLog: { flush(): void } }).bodyErrorLog.flush();
  });

  it('keeps other client errors on their usual line and genuine server errors at ERROR with the error object (stack)', () => {
    const notFound = run(new NotFoundException('Cannot GET /nope'), request());
    expect(notFound.logs.warn[0][0]).toContain('NotFoundException (404)');
    const boom = new Error('boom');
    const server = run(boom, request());
    expect(server.sent.status).toBe(500);
    expect(server.logs.error).toEqual([['[AppExceptionFilter] Unhandled exception (ip=203.0.113.9):', boom]]);
    expect(server.notify).toHaveBeenCalledTimes(1);
  });
});

describe('AppExceptionFilter — every 4xx line is rate-limited per status code, 5xx never', () => {
  const request = (): Req => ({ ip: '203.0.113.9', method: 'GET', url: '/api/v1/nope', socket: {} });
  const filterWith = () => {
    const notify = jest.fn();
    return { filter: new AppExceptionFilter({ safeNotify: notify } as never), notify };
  };
  const flush = (filter: AppExceptionFilter) => {
    const lines: string[] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push(String(line)); });
    (filter as unknown as { clientErrorLog: { flush(): void } }).clientErrorLog.flush();
    warn.mockRestore();
    return lines;
  };

  it(`writes at most ${CLIENT_ERROR_LOG_PER_MINUTE} lines per status and per minute, then a count, the response unchanged`, () => {
    const { filter } = filterWith();
    let lines = 0;
    let last: ReturnType<typeof run> | undefined;
    for (let i = 0; i < 50; i += 1) {
      last = run(new NotFoundException('Cannot GET /api/v1/nope'), request(), filter);
      lines += last.logs.warn.length;
    }
    expect(lines).toBe(CLIENT_ERROR_LOG_PER_MINUTE);
    expect(last?.sent.status).toBe(404);
    expect(last?.sent.body).toMatchObject({ code: 'ERR', statusCode: 404, message: 'Cannot GET /api/v1/nope', path: '/api/v1/nope' });
    expect(flush(filter)).toEqual([
      `[AppExceptionFilter] client errors: 30 more "404" line(s) suppressed (at most ${CLIENT_ERROR_LOG_PER_MINUTE} per 60 s)`,
    ]);
  });

  it('keeps one quota per status: 401 (invalid token), 403, 429 (limiter) and an Express 4xx each have their own', () => {
    const { filter } = filterWith();
    const count = (make: () => unknown) => {
      let lines = 0;
      for (let i = 0; i < 25; i += 1) lines += run(make(), request(), filter).logs.warn.length;
      return lines;
    };
    expect(count(() => new SecurityException('AUT', 'Invalid or expired token'))).toBe(CLIENT_ERROR_LOG_PER_MINUTE);
    expect(count(() => new ForbiddenException())).toBe(CLIENT_ERROR_LOG_PER_MINUTE);
    expect(count(() => new ThrottlerException())).toBe(CLIENT_ERROR_LOG_PER_MINUTE);
    expect(count(() => Object.assign(new Error('gone'), { status: 410, expose: true }))).toBe(CLIENT_ERROR_LOG_PER_MINUTE);
    const first = run(new ThrottlerException(), request(), filterWith().filter);
    expect(first.sent.status).toBe(429);
    expect(first.logs.warn).toEqual([[expect.stringMatching(/^\[AppExceptionFilter\] ThrottlerException \(429\) : .* \| ip=203\.0\.113\.9 \| endpoint=GET \/api\/v1\/nope \| detail=/)]]);
    flush(filter);
  });

  it('never limits 5xx: each one keeps its line (and an unknown error its ERROR with the stack and its notification)', () => {
    const { filter, notify } = filterWith();
    let warns = 0;
    let errors = 0;
    for (let i = 0; i < 30; i += 1) {
      warns += run(new ServiceUnavailableException('down'), request(), filter).logs.warn.length;
      warns += run(new TechnicalException('TEC', 'db'), request(), filter).logs.warn.length;
      errors += run(new Error('boom'), request(), filter).logs.error.length;
    }
    expect(warns).toBe(60);
    expect(errors).toBe(30);
    expect(notify).toHaveBeenCalledTimes(30);
    expect(flush(filter)).toEqual([]);
  });
});

describe('AppExceptionFilter — logged paths never carry secrets', () => {
  const SECRET = 'k9Fz3QpL0mWx7TbR2sVyN8aQ';
  const url = `/api/v1/agenthub/hooks/7/${SECRET}?token=${SECRET}`;
  const request = (): Req => ({ ip: '203.0.113.9', method: 'POST', url, originalUrl: url, socket: {} });

  it("redacts the path, the query and Nest's 404 message in the 4xx line; the response keeps the client's URL", () => {
    const { sent, logs } = run(new NotFoundException(`Cannot POST ${url}`), request());
    const line = String(logs.warn[0][0]);
    expect(line).not.toContain(SECRET);
    expect(line).toContain('endpoint=POST /api/v1/agenthub/hooks/7/[redacted]');
    expect(line).toContain('Cannot POST /api/v1/agenthub/hooks/7/[redacted]');
    expect(sent.body?.path).toBe(url);
  });

  it('redacts the body-error line, an AppException line and the Prowl notification of a 5xx', () => {
    const body = run(tooLarge(), request());
    expect(String(body.logs.warn[0][0])).toBe('[AppExceptionFilter] Client body error (413 entity.too.large) | ip=203.0.113.9 | endpoint=POST /api/v1/agenthub/hooks/7/[redacted]');
    const app = run(new SecurityException('AUT', 'Unauthorized'), request());
    expect(String(app.logs.warn[0][0])).not.toContain(SECRET);
    const server = run(new Error('boom'), request());
    const notice = String(server.notify.mock.calls[0][1]);
    expect(notice).toContain('POST /api/v1/agenthub/hooks/7/[redacted]');
    expect(notice).not.toContain(SECRET);
  });
});
