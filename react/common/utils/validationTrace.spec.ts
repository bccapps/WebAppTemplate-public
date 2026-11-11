/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posts: { url: string; body: unknown }[] = [];

vi.mock('../core/http/HttpService', () => ({
  httpService: {
    post: vi.fn((url: string, body: unknown) => {
      posts.push({ url, body });
      const chain: Record<string, () => unknown> = {};
      for (const name of ['then', 'fail', 'error', 'notAuthorized']) chain[name] = () => chain;
      return chain;
    }),
  },
}));
vi.mock('../services/ConfigurationService', () => ({
  configurationService: { getApiUrl: () => '/api/v1' },
}));

import { isValidationTraceActive, validationTrace } from './validationTrace';

describe('validationTrace', () => {
  beforeEach(() => {
    posts.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['production', undefined, false], ['prod', 'on', false], ['', undefined, false], [undefined, 'on', false], ['staging', 'on', false],
    ['dev', undefined, true], ['dev', 'off', false], ['dev', 'yes', false], ['preprod', undefined, false], ['preprod', 'on', true],
  ])('VITE_APP_ENV=%s, VITE_VALIDATION_TRACE=%s → active %s', (env, flag, expected) => expect(isValidationTraceActive(env, flag)).toBe(expected));

  it('sends nothing and evaluates nothing in production', () => {
    vi.stubEnv('VITE_APP_ENV', 'production');
    const lazy = vi.fn(() => ({ a: 1 }));
    validationTrace('user.settings.saved', 'ok', lazy);
    expect(lazy).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('posts simple fields only, without sensitive names, to the session or the pre-login route', () => {
    vi.stubEnv('VITE_APP_ENV', 'dev');
    validationTrace('user.settings.saved', 'ok', () => ({ section: 'profile', password: 'x', otpCode: 1, statusCode: 200, nested: { a: 1 }, long: 'y'.repeat(300) }));
    validationTrace('user.login.form-shown', 'info', undefined, { preLogin: true });
    expect(posts[0]).toEqual({
      url: '/api/v1/validation/trace',
      body: { check: 'user.settings.saved', outcome: 'ok', fields: { section: 'profile', statusCode: 200, long: 'y'.repeat(200) } },
    });
    expect(posts[1].url).toBe('/api/v1/validation/trace/public');
  });

  it('never throws', () => {
    vi.stubEnv('VITE_APP_ENV', 'preprod');
    vi.stubEnv('VITE_VALIDATION_TRACE', 'on');
    expect(() => validationTrace('a.b', 'ok', () => { throw new Error('boom'); })).not.toThrow();
  });
});
