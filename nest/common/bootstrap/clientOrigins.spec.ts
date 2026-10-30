/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  allowedClientOrigins,
  parseList,
  recordAllowedClientOrigins,
  resetAllowedClientOrigins,
  resolveClientOrigins,
  resolveFrontRedirectUrl,
} from './clientOrigins';

describe('resolveClientOrigins / allowedClientOrigins', () => {
  afterEach(() => resetAllowedClientOrigins());

  it('reads the explicit list, then CLIENT_ORIGINS, then the front dev port', () => {
    expect(resolveClientOrigins(' https://x.io ,', { CLIENT_ORIGINS: 'https://a.io' })).toEqual(['https://x.io']);
    expect(resolveClientOrigins(undefined, { CLIENT_ORIGINS: 'https://a.io, https://b.io' })).toEqual(['https://a.io', 'https://b.io']);
    expect(resolveClientOrigins(undefined, { FRONT_PORT: '5173' })).toEqual(['http://localhost:5173']);
    expect(parseList(' a, ,b ')).toEqual(['a', 'b']);
  });

  it('serves the list recorded by configureHttpApp, the environment before that', () => {
    expect(allowedClientOrigins({ CLIENT_ORIGINS: 'https://env.io' })).toEqual(['https://env.io']);
    recordAllowedClientOrigins(['https://applied.io']);
    expect(allowedClientOrigins({ CLIENT_ORIGINS: 'https://env.io' })).toEqual(['https://applied.io']);
  });
});

describe('resolveFrontRedirectUrl', () => {
  const ORIGINS = ['https://app.example', 'http://localhost:5173'];

  it.each([
    ['https://app.example/donate?x=1', 'https://app.example/donate?x=1'],
    ['http://localhost:5173/page#top', 'http://localhost:5173/page#top'],
    ['HTTPS://APP.EXAMPLE/a', 'https://app.example/a'],
    ['/thanks?donation=success', 'https://app.example/thanks?donation=success'],
    ['  /cancel  ', 'https://app.example/cancel'],
  ])('accepts %p as %p', (candidate, expected) => {
    expect(resolveFrontRedirectUrl(candidate, ORIGINS)).toBe(expected);
  });

  it.each([
    'https://evil.example/phish',
    'https://app.example.evil.example/',
    'https://app.example:8443/',
    'http://app.example/',
    '//evil.example/x',
    '/\\evil.example/x',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user:pw@app.example/',
    'relative/path',
    '',
    '   ',
  ])('refuses %p', (candidate) => {
    expect(resolveFrontRedirectUrl(candidate, ORIGINS)).toBeNull();
  });

  it('never matches through "*" and refuses everything without a usable origin', () => {
    expect(resolveFrontRedirectUrl('https://any.example/', ['*'])).toBeNull();
    expect(resolveFrontRedirectUrl('/x', ['*'])).toBeNull();
    expect(resolveFrontRedirectUrl('/x', ['*', 'https://app.example/'])).toBe('https://app.example/x');
    expect(resolveFrontRedirectUrl('https://app.example/x', [])).toBeNull();
  });
});
