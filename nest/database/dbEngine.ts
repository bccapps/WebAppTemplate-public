/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Engine helpers live in `common` (see `common/utils/dbEngine.ts`) so that `common` and `voice` never import this
 * module; they are re-exported here to keep the public API of `database` unchanged.
 */
export {
  connectionEnvPrefix,
  readConnectionEnv,
  resolveEngine,
  isSqlite,
  jsonColumnType,
  timestampColumnType,
  isSqliteDataSource,
  portableQuery,
} from '../common/utils/dbEngine';

/** Automatic Postgres → SQLite entity metadata adaptation, SQL dialect helpers and cross-engine runtime helpers (additions). */
export { applyPortableColumnTypes, portableTypesTotals, mapPostgresType, rewriteSqlDefault } from '../common/utils/portableTypes';
export type { PortableTypesReport } from '../common/utils/portableTypes';
export { dialect, dialectOf } from '../common/utils/dbDialect';
export type { Dialect } from '../common/utils/dbDialect';
export { parseDbDate, parseDbDateOrNull, toNumber } from '../common/utils/dbDate';
export { isUniqueViolation, isForeignKeyViolation, isNotNullViolation } from '../common/utils/dbErrors';
