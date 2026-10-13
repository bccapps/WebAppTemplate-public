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
