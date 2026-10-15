/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Schema part of the database portability check, run INSIDE the app by `db-portability-check.mjs` (cwd = the back directory,
 * ts-node registered): builds an in-memory SQLite DataSource from the app's entities after the automatic Postgres → SQLite
 * adaptation, and reports every entity / column the SQLite driver still refuses, then synchronises the schema to catch SQL errors.
 * Shared modules whose `module.json` does not list `sqlite` in `databases` are skipped (their entities are Postgres only).
 * Prints one JSON line prefixed with `__VX_DBCHECK__`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

process.env.DB_ENGINE = 'sqlite';
process.env.DB_PATH = ':memory:';
process.env.DB_PORTABLE_LOG = 'false';
for (const key of ['DB_SYNC', 'TYPEORM_SYNC', 'DB_MIGRATIONS_RUN', 'DB_CONNECTIONS', 'DB_MODULE_ROUTING']) delete process.env[key];

const root = process.cwd();
const src = path.join(root, 'src');
const options = JSON.parse(process.env.VX_DBCHECK_OPTIONS || '{}');

function tryRequire(candidates) {
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  return null;
}

function moduleDatabases(moduleDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8'));
    return Array.isArray(parsed.databases) ? parsed.databases.map((value) => String(value).toLowerCase()) : null;
  } catch {
    return null;
  }
}

/** Every `entities` directory under a module (nested ones too: `game/entities`), symlinked shared modules followed. */
function findEntityDirs(dir, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    if (name === 'entities') found.push(full);
    else found.push(...findEntityDirs(full, depth + 1));
  }
  return found;
}

/** Entity directories of the app: the `entities` directories of every module of src/modules and src/modules_shared (symlinks followed). */
function entityDirectories() {
  const out = [];
  for (const area of ['modules', 'modules_shared']) {
    const areaDir = path.join(src, area);
    if (!fs.existsSync(areaDir)) continue;
    for (const id of fs.readdirSync(areaDir).sort()) {
      const moduleDir = path.join(areaDir, id);
      const databases = moduleDatabases(moduleDir);
      for (const dir of findEntityDirs(moduleDir)) out.push({ id, area, dir, databases });
    }
  }
  return out;
}

async function main() {
  require(require.resolve('reflect-metadata', { paths: [root] }));
  const typeorm = require(require.resolve('typeorm', { paths: [root] }));
  const portable = tryRequire([
    path.join(src, 'modules_shared/common/utils/portableTypes'),
    path.join(root, '.libs/vx-public/nest/common/utils/portableTypes'),
  ]);
  const loader = require(require.resolve('typeorm/util/DirectoryExportedClassesLoader', { paths: [root] }));
  const silentLogger = { log() {}, logQuery() {}, logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {} };

  const report = { engine: 'sqlite', normaliser: Boolean(portable), entities: 0, modules: [], skipped: [], failures: [], adapted: null };
  if (portable) {
    portable.applyPortableColumnTypes('sqlite');
  } else {
    report.failures.push({ stage: 'setup', message: 'common/utils/portableTypes not found: the automatic Postgres → SQLite adaptation is not available in this project' });
  }

  let classes = [];
  const owner = new Map();
  for (const directory of entityDirectories()) {
    if (directory.databases && !directory.databases.includes('sqlite') && !options.includePostgresOnly) {
      if (!report.skipped.some((entry) => entry.module === directory.id)) report.skipped.push({ module: directory.id, reason: `module.json databases = ${JSON.stringify(directory.databases)} (no sqlite)` });
      continue;
    }
    try {
      const imported = await loader.importClassesFromDirectories(silentLogger, [path.join(directory.dir, '*.{js,ts}')]);
      const entityClasses = imported.filter((value) => typeof value === 'function');
      for (const entity of entityClasses) owner.set(entity, directory.id);
      classes.push(...entityClasses);
      const existing = report.modules.find((entry) => entry.module === directory.id);
      if (existing) existing.files += entityClasses.length;
      else report.modules.push({ module: directory.id, files: entityClasses.length });
    } catch (error) {
      report.failures.push({ stage: 'import', module: directory.id, message: String(error && error.message ? error.message : error) });
    }
  }
  // Only classes registered as entities (a helper class exported from an entity file is not one).
  const tables = new Set(typeorm.getMetadataArgsStorage().tables.map((table) => table.target));
  classes = [...new Set(classes)].filter((entity) => tables.has(entity));
  report.entities = classes.length;

  const refusal = /Data type "([^"]+)" in "([^".]+)\.([^"]+)" is not supported by "[^"]*" database/;
  let dataSource;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    dataSource = new typeorm.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: classes, synchronize: false });
    try {
      await dataSource.initialize();
      break;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const match = refusal.exec(message);
      const failed = match ? classes.filter((entity) => entity.name === match[2]) : [];
      report.failures.push({
        stage: 'metadata',
        ...(match ? { entity: match[2], column: match[3], type: match[1], module: owner.get(failed[0]) } : {}),
        message,
      });
      if (dataSource.isInitialized) await dataSource.destroy();
      dataSource = undefined;
      if (!failed.length) break;
      classes = classes.filter((entity) => !failed.includes(entity));
    }
  }
  if (dataSource) {
    try {
      await dataSource.synchronize();
    } catch (error) {
      report.failures.push({ stage: 'synchronize', message: String(error && error.message ? error.message : error) });
    }
    await dataSource.destroy();
  }
  if (portable) report.adapted = portable.portableTypesTotals();
  process.stdout.write(`\n__VX_DBCHECK__${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stdout.write(`\n__VX_DBCHECK__${JSON.stringify({ engine: 'sqlite', entities: 0, modules: [], skipped: [], failures: [{ stage: 'fatal', message: String(error && error.stack ? error.stack : error) }], adapted: null })}\n`);
});
