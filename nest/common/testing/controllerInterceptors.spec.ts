/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { Controller, Delete, Get, Post, Put, UseInterceptors } from '@nestjs/common';
import { type CriticalRoute, findRouteMismatches, findShadowedRoutes, findUnclassifiedWriteRoutes, type OpenRoute, routesOf } from './controllerInterceptors.testkit';

class A {}
class B {}

@Controller('api/v1/things')
@UseInterceptors(A)
class FakeController {
  @Get()
  list(): void {}

  @Post(':id/run')
  @UseInterceptors(B)
  run(): void {}

  @Delete('/:id/')
  @UseInterceptors(B, A)
  remove(): void {}

  helper(): void {}
}

@Controller('api/v1/shadow')
class ShadowController {
  @Put(':id')
  update(): void {}

  @Put('default-model')
  setDefault(): void {}

  @Get(':id')
  read(): void {}
}

@Controller('api/v1/ordered')
class OrderedController {
  @Put('default-model')
  setDefault(): void {}

  @Put(':id')
  update(): void {}
}

describe('controllerInterceptors.testkit', () => {
  it('enumerates routes with class-then-method interceptors and normalised paths', () => {
    expect(routesOf(FakeController).map((r) => [r.method, r.path, r.interceptors])).toEqual([
      ['GET', '/api/v1/things', [A]],
      ['POST', '/api/v1/things/:id/run', [A, B]],
      ['DELETE', '/api/v1/things/:id', [A, B, A]],
    ]);
  });

  it('accepts routes carrying the interceptors in order', () => {
    expect(findRouteMismatches(FakeController, [{ method: 'POST', path: '/api/v1/things/:id/run', interceptors: [A, B] }])).toEqual([]);
  });

  it('reports a missing interceptor, a wrong order and an unknown route', () => {
    const problems = findRouteMismatches(FakeController, [
      { method: 'GET', path: '/api/v1/things', interceptors: [A, B] },
      { method: 'POST', path: '/api/v1/things/:id/run', interceptors: [B, A] },
      { method: 'PUT', path: '/api/v1/things', interceptors: [A] },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('B missing or out of order');
    expect(problems[1]).toContain('A missing or out of order');
    expect(problems[2]).toContain('no such route');
  });

  describe('findUnclassifiedWriteRoutes', () => {
    const critical: CriticalRoute[] = [{ method: 'POST', path: '/api/v1/things/:id/run', interceptors: [A, B] }];
    const open: OpenRoute[] = [{ method: 'DELETE', path: '/api/v1/things/:id', reason: 'test fixture' }];

    it('accepts a controller whose every write route is critical or open', () => {
      expect(findUnclassifiedWriteRoutes(FakeController, critical, open)).toEqual([]);
    });

    it('never asks for a classification of GET routes', () => {
      expect(findUnclassifiedWriteRoutes(FakeController, critical, open).join()).not.toContain('GET');
    });

    it('fails on a write route that is neither critical nor open', () => {
      const problems = findUnclassifiedWriteRoutes(FakeController, critical, []);
      expect(problems).toEqual(['DELETE /api/v1/things/:id (remove): write route in neither CRITICAL_ROUTES nor OPEN_ROUTES']);
    });

    it('fails on a stale, reasonless or doubly classified OPEN_ROUTES entry', () => {
      const problems = findUnclassifiedWriteRoutes(FakeController, critical, [
        { method: 'DELETE', path: '/api/v1/things/:id', reason: ' ' },
        { method: 'PUT', path: '/api/v1/things', reason: 'gone' },
        { method: 'POST', path: '/api/v1/things/:id/run', reason: 'also critical' },
      ]);
      expect(problems).toHaveLength(3);
      expect(problems[0]).toContain('without a reason');
      expect(problems[1]).toContain('names no route');
      expect(problems[2]).toContain('both CRITICAL_ROUTES and OPEN_ROUTES');
    });

    it('reports a param route declared before a static sibling', () => {
      const problems = findUnclassifiedWriteRoutes(ShadowController, [], [
        { method: 'PUT', path: '/api/v1/shadow/:id', reason: 'fixture' },
        { method: 'PUT', path: '/api/v1/shadow/default-model', reason: 'fixture' },
      ]);
      expect(problems).toEqual(['PUT /api/v1/shadow/default-model (setDefault) is shadowed by /api/v1/shadow/:id (update) declared before it']);
    });
  });

  describe('findShadowedRoutes', () => {
    it('flags the static route declared after a param route only', () => {
      expect(findShadowedRoutes(ShadowController)).toHaveLength(1);
      expect(findShadowedRoutes(OrderedController)).toEqual([]);
    });

    it('ignores routes of another method or depth', () => {
      expect(findShadowedRoutes(FakeController)).toEqual([]);
    });
  });
});
