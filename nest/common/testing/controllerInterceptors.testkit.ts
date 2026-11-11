/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import 'reflect-metadata';
import { INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

/** One route handler of a controller, as Nest sees it from the decorators' metadata (no app boot, no DB). */
export interface RouteInfo {
  handlerName: string;
  method: string;
  /** Class prefix + route path, normalised: leading `/`, no trailing `/`. */
  path: string;
  /** Class-level interceptors first, then route-level ones: the order Nest runs them in. */
  interceptors: ClassRef[];
}

/** A route that MUST carry `interceptors` in this relative order (other interceptors may sit between them). */
export interface CriticalRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  interceptors: ClassRef[];
}

/**
 * A WRITE route (anything but GET/HEAD/OPTIONS) deliberately left without a principal guard, with the one-line
 * reason why (e.g. "anonymous checkout", "admin route behind AdminOnlyInterceptor, no API-token concern", "webhook").
 */
export interface OpenRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  reason: string;
}

/** Any class (a controller, an interceptor): constructor arguments never matter here. */
export type ClassRef = abstract new (...args: never[]) => unknown;

type Ctor = ClassRef;

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => String(part ?? '').split('/'))
    .filter((segment) => segment !== '')
    .join('/');
  return `/${joined}`;
}

function pathsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : ''];
}

/** Every route handler of `controller` (one entry per path when a decorator lists several). */
export function routesOf(controller: Ctor): RouteInfo[] {
  const classPaths = pathsOf(Reflect.getMetadata(PATH_METADATA, controller));
  const classInterceptors: ClassRef[] = Reflect.getMetadata(INTERCEPTORS_METADATA, controller) ?? [];
  const routes: RouteInfo[] = [];
  for (const handlerName of Object.getOwnPropertyNames(controller.prototype)) {
    if (handlerName === 'constructor') continue;
    const handler = (controller.prototype as Record<string, unknown>)[handlerName];
    if (typeof handler !== 'function') continue;
    const requestMethod: number | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
    if (requestMethod === undefined) continue;
    const methodInterceptors: ClassRef[] = Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ?? [];
    for (const classPath of classPaths) {
      for (const routePath of pathsOf(Reflect.getMetadata(PATH_METADATA, handler))) {
        routes.push({
          handlerName,
          method: RequestMethod[requestMethod],
          path: joinPath(classPath, routePath),
          interceptors: [...classInterceptors, ...methodInterceptors],
        });
      }
    }
  }
  return routes;
}

/**
 * Human-readable problems of `controller` against its `critical` routes: a listed route that no longer exists
 * (renamed or removed: update the list), or one missing an expected interceptor or carrying them out of order.
 * `[]` = all good. A route NOT in the list is not checked: keep the list next to the controller spec.
 */
export function findRouteMismatches(controller: Ctor, critical: readonly CriticalRoute[]): string[] {
  const routes = routesOf(controller);
  const problems: string[] = [];
  for (const wanted of critical) {
    const path = joinPath(wanted.path);
    const route = routes.find((candidate) => candidate.method === wanted.method && candidate.path === path);
    if (!route) {
      problems.push(`${wanted.method} ${path}: no such route on ${controller.name}`);
      continue;
    }
    let from = 0;
    for (const expected of wanted.interceptors) {
      const at = route.interceptors.indexOf(expected, from);
      if (at < 0) {
        const present = route.interceptors.map((i) => i.name).join(' > ') || '(none)';
        problems.push(`${wanted.method} ${path} (${route.handlerName}): ${expected.name} missing or out of order; has ${present}`);
        break;
      }
      from = at + 1;
    }
  }
  return problems;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const routeKey = (method: string, path: string): string => `${method} ${joinPath(path)}`;

function isParam(segment: string): boolean {
  return segment.startsWith(':');
}

/**
 * Routes a param route would shadow: same method, same depth, declared BEFORE a static sibling that its pattern
 * also matches (`GET :id` before `GET default-model`: Express answers the first match, the static route is never
 * reached). Only inside one controller (a clash between two controllers cannot be seen from here).
 */
export function findShadowedRoutes(controller: Ctor): string[] {
  const routes = routesOf(controller);
  const problems: string[] = [];
  routes.forEach((earlier, i) => {
    const earlierSegments = earlier.path.split('/');
    for (const later of routes.slice(i + 1)) {
      if (later.method !== earlier.method) continue;
      const laterSegments = later.path.split('/');
      if (laterSegments.length !== earlierSegments.length) continue;
      const matches = earlierSegments.every((segment, at) => isParam(segment) || segment === laterSegments[at]);
      const hasStaticWhereParam = earlierSegments.some((segment, at) => isParam(segment) && !isParam(laterSegments[at]));
      if (matches && hasStaticWhereParam) {
        problems.push(
          `${later.method} ${later.path} (${later.handlerName}) is shadowed by ${earlier.path} (${earlier.handlerName}) declared before it`,
        );
      }
    }
  });
  return problems;
}

/**
 * Drift guard for WRITE routes: every non-GET handler of `controller` must be listed in `critical` (guarded, see
 * {@link findRouteMismatches}) or in `open` (deliberately unguarded, with a reason), so a new write route without a
 * decision fails the spec. Also reports an `open` entry without reason, naming no route, or also listed as critical,
 * and a param route declared before a static sibling it would shadow. `[]` = all good.
 */
export function findUnclassifiedWriteRoutes(
  controller: Ctor,
  critical: readonly CriticalRoute[],
  open: readonly OpenRoute[],
): string[] {
  const routes = routesOf(controller);
  const known = new Set(routes.map((route) => routeKey(route.method, route.path)));
  const criticalKeys = new Set(critical.map((route) => routeKey(route.method, route.path)));
  const openKeys = new Set(open.map((route) => routeKey(route.method, route.path)));
  const problems: string[] = [];
  for (const route of open) {
    const key = routeKey(route.method, route.path);
    if (!route.reason.trim()) problems.push(`${key}: OPEN_ROUTES entry without a reason`);
    if (!known.has(key)) problems.push(`${key}: OPEN_ROUTES entry names no route on ${controller.name}`);
    if (criticalKeys.has(key)) problems.push(`${key}: listed in both CRITICAL_ROUTES and OPEN_ROUTES`);
  }
  for (const route of routes) {
    if (READ_METHODS.has(route.method)) continue;
    const key = routeKey(route.method, route.path);
    if (!criticalKeys.has(key) && !openKeys.has(key)) {
      problems.push(`${key} (${route.handlerName}): write route in neither CRITICAL_ROUTES nor OPEN_ROUTES`);
    }
  }
  return [...problems, ...findShadowedRoutes(controller)];
}
