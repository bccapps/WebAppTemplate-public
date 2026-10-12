/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Module → database connection routing.
 *
 * The default connection is named "main" and maps to the NestJS *default*
 * (unnamed) connection, so existing `@InjectRepository(Entity)` wiring keeps
 * working untouched. Additional named connections are declared via env and a
 * module is routed to one of them through `DB_MODULE_ROUTING`.
 *
 * Env contract:
 *   DB_CONNECTIONS=analytics,archive          // extra named connections
 *   DB_MODULE_ROUTING={"token-trader":"analytics"}  // moduleId -> connection
 *
 * When both are empty the routing is "dormant": a single "main" connection is
 * built, byte-for-byte identical to the legacy single-DataSource behaviour.
 */

/** Logical name of the default connection (NestJS default / unnamed). */
export const MAIN_CONNECTION = 'main';

/** Parse `DB_MODULE_ROUTING` (JSON). Invalid JSON is ignored (dormant-safe). */
export function parseModuleRouting(): Record<string, string> {
  const raw = process.env.DB_MODULE_ROUTING?.trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Parse `DB_CONNECTIONS` (csv). The reserved "main" name is filtered out. */
export function parseConnectionNames(): string[] {
  const raw = process.env.DB_CONNECTIONS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean)
    .filter((name: string) => name !== MAIN_CONNECTION);
}

/** Logical connection a module reads its repositories from ("main" by default). */
export function dbFor(moduleId: string): string {
  return parseModuleRouting()[moduleId] ?? MAIN_CONNECTION;
}

/**
 * NestJS injection token for a logical connection. "main" → `undefined`
 * (the default connection), any other name → the name itself. Use for both
 * `TypeOrmModule.forFeature(entities, connectionToken(dbFor('mod')))` and
 * `@InjectRepository(Entity, connectionToken(dbFor('mod')))`.
 */
export function connectionToken(name: string): string | undefined {
  return name === MAIN_CONNECTION ? undefined : name;
}

/** True when at least one extra connection or one routing entry is configured. */
export function isRoutingActive(): boolean {
  return (
    parseConnectionNames().length > 0 ||
    Object.keys(parseModuleRouting()).length > 0
  );
}
