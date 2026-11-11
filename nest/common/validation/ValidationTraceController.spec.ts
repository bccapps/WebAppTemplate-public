/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { RejectApiTokenInterceptor } from '../interceptors/RejectApiTokenInterceptor';
import { findRouteMismatches, findUnclassifiedWriteRoutes } from '../testing/controllerInterceptors.testkit';
import { leaksSecret, secretFixtures } from './secretFixtures.testkit';
import { loadCheckIndex } from './checkIndex';
import { ValidationTraceController } from './ValidationTraceController';
import { ValidationTraceModule } from './ValidationTraceModule';
import { configureValidationTrace } from './validationTrace';

const DEV = { APP_ENV: 'dev', VALIDATION_TRACE: 'on', PROJECT_NAME: 'demo' };

let roots: string;
beforeAll(() => {
  roots = fs.mkdtempSync(path.join(os.tmpdir(), 'vchecks-'));
  const write = (module: string, content: string) => {
    fs.mkdirSync(path.join(roots, module, 'validation'), { recursive: true });
    fs.writeFileSync(path.join(roots, module, 'validation', 'checks.json'), content);
  };
  const check = (id: string, extra: object) => ({ id, module: id.split('.')[0], expect: { traces: [id], outcome: 'ok' }, ...extra });
  write('user', JSON.stringify({ checks: [
    check('user.login.form-shown', { sources: ['front'], preLogin: true, fields: { step: ['email', 'otp'] } }),
    check('user.settings.saved', { sources: ['back', 'front'], mustNotHappen: ['user.settings.lost:violation'], fields: { section: 'string', note: 'string', token: 'string', nested: 'string' } }),
    check('user.login.otp-required', { sources: ['back'] }),
    check('user.front.shared', { sources: ['front'], fields: '*', fieldsJustification: 'refused for a front check anyway' }),
    check('user.back.only', { sources: ['back'], expect: { traces: ['user.front.shared'], outcome: 'ok' } }),
  ] }));
  write('broken', '{ not json');
  fs.mkdirSync(path.join(roots, 'no-checks'));
});
afterAll(() => fs.rmSync(roots, { recursive: true, force: true }));

describe('loadCheckIndex', () => {
  it('allow-lists the front traces only, minus names a back-only check uses; "*" is never granted to the front', () => {
    const { front, back } = loadCheckIndex([roots, path.join(roots, 'missing')]);
    expect(Object.fromEntries(front)).toEqual({
      'user.login.form-shown': { preLogin: true, fields: { step: ['email', 'otp'] } },
      'user.settings.saved': { preLogin: false, fields: { section: 'string', note: 'string', token: 'string', nested: 'string' } },
      'user.settings.lost': { preLogin: false, fields: { section: 'string', note: 'string', token: 'string', nested: 'string' } },
    });
    expect(back.get('user.login.otp-required')).toEqual({});
    expect(back.has('user.front.shared')).toBe(true);
  });
});

describe('ValidationTraceController routes (principal guards)', () => {
  const CRITICAL = [{ method: 'POST' as const, path: '/api/v1/validation/trace', interceptors: [RejectApiTokenInterceptor] }];
  const OPEN = [{ method: 'POST' as const, path: '/api/v1/validation/trace/public', reason: 'pre-login traces of checks marked preLogin, dev/preprod only, allow-listed and throttled' }];
  it('classifies every write route', () => {
    expect(findUnclassifiedWriteRoutes(ValidationTraceController, CRITICAL, OPEN)).toEqual([]);
    expect(findRouteMismatches(ValidationTraceController, CRITICAL)).toEqual([]);
  });
});

describe('POST /api/v1/validation/trace over HTTP', () => {
  let app: INestApplication | undefined;
  let lines: string[];

  async function boot(env: Record<string, string>): Promise<INestApplication> {
    lines = [];
    configureValidationTrace({ env, sink: { write: (line) => (lines.push(line), true) }, log: () => undefined, checkRoots: [roots] });
    const mod = await Test.createTestingModule({ imports: [ValidationTraceModule.register()] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    return app;
  }
  const post = (target: INestApplication, route: string, body: object) => request(target.getHttpServer()).post(`/api/v1/validation/${route}`).send(body);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    configureValidationTrace({ env: {} });
  });

  it.each([{ APP_ENV: 'prod', VALIDATION_TRACE: 'on' }, { VALIDATION_TRACE: 'on' }])('does not exist in production or without APP_ENV (%j): 404', async (env) => {
    const target = await boot(env);
    expect((await post(target, 'trace', { check: 'user.settings.saved', outcome: 'ok' })).status).toBe(404);
    expect((await post(target, 'trace/public', { check: 'user.login.form-shown', outcome: 'ok' })).status).toBe(404);
    expect(lines).toEqual([]);
  });

  it('answers 404 again when traces are switched off after the route was registered', async () => {
    const target = await boot(DEV);
    configureValidationTrace({ env: { APP_ENV: 'prod' } });
    expect((await post(target, 'trace', { check: 'user.settings.saved', outcome: 'ok' })).status).toBe(404);
  });

  it('records an allow-listed front trace: declared fields only, sanitized, source "front", ids not promoted', async () => {
    const target = await boot(DEV);
    const { appToken, jwt } = secretFixtures();
    const fields = { section: 'profile', note: `copied ${appToken}`, token: jwt, nested: { a: 1 }, undeclared: 'x', requestId: 'forged-by-the-front' };
    const res = await post(target, 'trace', { check: 'user.settings.saved', outcome: 'ok', fields });
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ check: 'user.settings.saved', outcome: 'ok', source: 'front', env: 'dev', fields: { section: 'profile', token: '[redacted:' + jwt.length + ']', _droppedFields: 3 } });
    expect(line.requestId).toBeUndefined();
    expect(line.fields.note).toMatch(/^hmac:/);
    expect(leaksSecret(lines[0], appToken) || leaksSecret(lines[0], jwt) || lines[0].includes('forged')).toBe(false);
  });

  it.each([
    ['an undeclared check', 'trace', { check: 'user.unknown', outcome: 'ok' }],
    ['a back-only check', 'trace', { check: 'user.login.otp-required', outcome: 'ok' }],
    ['a front name also used by a back-only check', 'trace', { check: 'user.front.shared', outcome: 'ok' }],
    ['a front check that is not pre-login, on the public route', 'trace/public', { check: 'user.settings.saved', outcome: 'ok' }],
    ['a bad outcome', 'trace', { check: 'user.settings.saved', outcome: 'maybe' }],
    ['a bad check name', 'trace', { check: 'User Settings', outcome: 'ok' }],
    ['fields that are not an object', 'trace', { check: 'user.settings.saved', outcome: 'ok', fields: ['a'] }],
    ['oversized fields', 'trace', { check: 'user.settings.saved', outcome: 'ok', fields: { big: 'x'.repeat(3000) } }],
    ['too many fields', 'trace', { check: 'user.settings.saved', outcome: 'ok', fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) }],
  ])('refuses %s (400) and records nothing', async (_name, route, body) => {
    const target = await boot(DEV);
    expect((await post(target, route, body)).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it('accepts a pre-login check on the public route', async () => {
    const target = await boot(DEV);
    expect((await post(target, 'trace/public', { check: 'user.login.form-shown', outcome: 'info', fields: { step: 'otp' } })).status).toBe(204);
    expect(JSON.parse(lines[0])).toMatchObject({ check: 'user.login.form-shown', outcome: 'info', source: 'front', fields: { step: 'otp' } });
  });
});
