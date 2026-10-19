/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { AppExceptionFilter, httpErrorStatus } from './AppExceptionFilter';

function run(exception: unknown) {
  const notify = jest.fn();
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const response = {
    headersSent: false,
    status: (code: number) => { sent.status = code; return response; },
    send: (body: Record<string, unknown>) => { sent.body = body; },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ ip: '1.2.3.4', method: 'POST', url: '/x' }) }),
    getClass: () => ({ name: 'Svc' }),
    getHandler: () => ({ name: 'handler' }),
  };
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  new AppExceptionFilter({ safeNotify: notify } as never).catch(exception, host as never);
  warn.mockRestore();
  error.mockRestore();
  return { sent, notify };
}

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
