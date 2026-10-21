#!/usr/bin/env node
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Interactive project creation wizard (Node >= 20, no dependency).
 * `scripts/create-project.sh` is a thin wrapper around this file.
 *
 * The wizard never edits code (AppModule.ts, App.tsx, ...): it chooses modules and
 * produces configuration (shared-modules.json, .env files, project.config.json,
 * defaultConfig.ts). Module wiring is done by the modules' plugins.
 *
 *   create-project.mjs [options] [<project-name> [<parent-dir>]]
 *
 * Every answer has a CLI equivalent (see `--help`). `--answers <file.json>` has the
 * schema of project.config.json; `--yes` accepts every default; `--dry-run` prints the
 * plan and writes nothing.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DB_ENGINES, DB_ENGINE_LABELS, applyEnvValues, buildConfigEntries, buildEnvFromAnswers, buildSharedModules,
  envExampleBody, frontPackageLocal, loadCatalog, normalizeAnswers, patchDefaultConfig, renderEnvExample, resolveDesktop, resolveProject, resolvePwa, supportsDatabase,
  validateAnswers, withQuestionDefaults,
} from './lib/project-engine.mjs';
import { installDesktop } from './lib/desktop-install.mjs';
import { Prompter, askModuleQuestions, csv, selectFunctionalModules } from './lib/wizard.mjs';

const SCRIPT_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_PRIVATE_URL = 'https://github.com/bccapps/WebAppTemplate-private.git';

const log = {
  info: (m) => console.log(`\x1b[1;34m==>\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[1;32m✓\x1b[0m  ${m}`),
  warn: (m) => console.warn(`\x1b[1;33m⚠\x1b[0m  ${m}`),
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `Usage: create-project.mjs [options] [<project-name> [<parent-dir>]]

Answers (each one is asked interactively when not given):
  --name <kebab>            project name (also first positional)
  --site-name <text>        display name of the site            --entity <text>   publisher entity
  --email <address>         contact email                       --github-org <o>  GitHub organization [bccapps]
  --back-port <n>           [3000]                              --front-port <n>  [5173]
  --private | --no-private  mount vx-private (alias: --with-private)
  --multi-user | --no-multi-user   user accounts and login (alias: --with-users)
  --local-trust | --no-local-trust   single-user local app: no admin key on loopback (LOCAL_TRUST, needs no user module)
  --pwa | --no-pwa          installable app (PWA: manifest, service worker, install button) [no]
  --pwa-name <text> --pwa-short-name <text> (<= 12 chars)   --pwa-theme-color <#rrggbb> --pwa-background-color <#rrggbb>
  --desktop | --no-desktop  desktop application (Tauri shell: desktop/, build-desktop.yml, desktop:dev / desktop:build); implies SQLite by
                            default, refused with the user module or another database [no]
  --desktop-name <text> --desktop-identifier <com.example.app>   product name [site name] and reverse-domain id [com.example.<name>]
  --commerce | --no-commerce       enable the sales screens (needs multi-user)
  --modules a,b             extra functional modules (closure of "requires" is added)
  --db <selfhosted|cloud|supabase|neon|sqlite>   --redis | --no-redis
  --langs fr,en             first one = default language
  --answer <questionId>=<value>   answer a module question (repeatable; lists comma-separated)
  --answers <file.json>     answers file (project.config.json schema)
  --yes                     accept every default, no question      --dry-run   print the plan, write nothing
Other:
  --no-install --no-github --no-commit
  --public-dir <dir> --private-dir <dir>   local library checkouts used as catalog source (dry-run / --vendor-libs)
  --vendor-libs             copy the libraries into .libs instead of adding submodules (tests/CI)
Environment: VX_PUBLIC_URL, VX_PRIVATE_URL, LIB_BRANCH (see scripts/lib/libs.sh)
`;

const BOOL_FLAGS = new Set([
  'private', 'no-private', 'with-private', 'multi-user', 'no-multi-user', 'with-users', 'commerce', 'no-commerce', 'local-trust', 'no-local-trust', 'pwa', 'no-pwa', 'desktop', 'no-desktop',
  'redis', 'no-redis', 'yes', 'dry-run', 'no-install', 'no-github', 'no-commit', 'vendor-libs', 'help',
]);

/** Minimal argv parser. Repeatable: --answer, --module(s). */
export function parseCli(argv) {
  const opts = { positional: [], answer: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts.positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
    if (BOOL_FLAGS.has(rawKey)) {
      opts[rawKey] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`option --${rawKey} needs a value`);
    if (rawKey === 'answer') opts.answer.push(value);
    else opts[rawKey] = value;
  }
  return opts;
}


function parseAnswerValue(raw, question) {
  if (!question) return raw;
  if (question.type === 'confirm') return /^(1|true|yes|y|o|oui)$/i.test(raw);
  if (question.type === 'multiselect') return csv(raw);
  return raw;
}

/** CLI flags -> partial answers (only what was given). */
export function answersFromCli(opts) {
  const a = {};
  const set = (k, v) => { if (v !== undefined && v !== '') a[k] = v; };
  set('projectName', opts.name ?? opts.positional[0]);
  set('siteName', opts['site-name']);
  set('entityName', opts.entity);
  set('contactEmail', opts.email);
  set('githubOrg', opts['github-org']);
  if (opts['back-port'] || opts['front-port']) {
    a.ports = {};
    if (opts['back-port']) a.ports.back = Number(opts['back-port']);
    if (opts['front-port']) a.ports.front = Number(opts['front-port']);
  }
  if (opts.private || opts['with-private']) a.privateAccess = true;
  if (opts['no-private']) a.privateAccess = false;
  if (opts['multi-user'] || opts['with-users']) a.multiUser = true;
  if (opts['no-multi-user']) a.multiUser = false;
  if (opts['local-trust']) a.localTrust = true;
  if (opts['no-local-trust']) a.localTrust = false;
  if (opts.pwa) a.pwa = { enabled: true };
  if (opts['no-pwa']) a.pwa = { enabled: false };
  const pwaFields = { name: opts['pwa-name'], shortName: opts['pwa-short-name'], themeColor: opts['pwa-theme-color'], backgroundColor: opts['pwa-background-color'] };
  for (const [key, value] of Object.entries(pwaFields)) if (value) a.pwa = { ...(a.pwa ?? {}), [key]: value };
  if (opts.desktop) a.desktop = { enabled: true };
  if (opts['no-desktop']) a.desktop = { enabled: false };
  for (const [key, value] of Object.entries({ productName: opts['desktop-name'], identifier: opts['desktop-identifier'] })) if (value) a.desktop = { ...(a.desktop ?? {}), [key]: value };
  if (opts.commerce) a.commerce = true;
  if (opts['no-commerce']) a.commerce = false;
  if (opts.modules) a.modules = csv(opts.modules);
  if (opts.db || opts.redis || opts['no-redis']) {
    a.database = {};
    if (opts.db) a.database.engine = opts.db;
    if (opts.redis) a.database.redis = true;
    if (opts['no-redis']) a.database.redis = false;
  }
  if (opts.langs) a.languages = csv(opts.langs);
  return a;
}

function mergeAnswers(...layers) {
  const out = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(out[k] ?? {}), ...v } : v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function privateProbe() {
  const url = process.env.VX_PRIVATE_URL || DEFAULT_PRIVATE_URL;
  const r = spawnSync('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
    stdio: 'ignore', timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
  });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// Catalog sources
// ---------------------------------------------------------------------------

function hasLib(dir) {
  return Boolean(dir) && existsSync(path.join(dir, 'nest')) && existsSync(path.join(dir, 'react'));
}

/** Directory with the private libraries for catalog reading in dry-run/vendor mode. */
function privateCatalogDir(opts, tmpDirs) {
  const given = opts['private-dir'] || process.env.VX_PRIVATE_DIR;
  if (given) return path.resolve(given);
  const tmp = mkdtempSync(path.join(tmpdir(), 'vx-private-'));
  tmpDirs.push(tmp);
  const url = process.env.VX_PRIVATE_URL || DEFAULT_PRIVATE_URL;
  const r = spawnSync('git', ['clone', '--depth', '1', '-q', '-b', process.env.LIB_BRANCH || 'main', url, tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`cannot read the private library from ${url} (use --private-dir <local clone>)`);
  return tmp;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

const defaultSiteName = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Run the interactive part. `catalogFor(answers)` is called once the access question
 * is answered and returns the catalog (it may mount the libraries as a side effect).
 */
export async function collectAnswers({ opts, given, prompter, catalogFor }) {
  const a = normalizeAnswers(given);
  const ask = prompter.interactive;
  const known = (key) => given[key] !== undefined;

  a.projectName = known('projectName') ? given.projectName : await prompter.text('Project name (kebab-case)', '');
  a.siteName = known('siteName') ? given.siteName : await prompter.text('Site name', defaultSiteName(a.projectName || 'my-app'));
  a.entityName = known('entityName') ? given.entityName : await prompter.text('Publisher entity name', '');
  a.contactEmail = known('contactEmail') ? given.contactEmail : await prompter.text('Contact email', '');
  a.githubOrg = given.githubOrg ?? await prompter.text('GitHub organization', 'bccapps');
  if (!given.ports?.back) a.ports.back = Number(await prompter.text('Backend port (NODE_PORT)', '3000'));
  if (!given.ports?.front) a.ports.front = Number(await prompter.text('Frontend port (FRONT_PORT)', '5173'));

  if (given.privateAccess === undefined) {
    // Default = "yes" when the private repository is reachable. Answers files stay deterministic: no probe.
    const reachable = ask || opts.yes ? privateProbe() : false;
    a.privateAccess = ask ? await prompter.confirm('Access to the private modules (vx-private)?', reachable) : reachable;
  }
  const catalog = await catalogFor(a);

  if (given.desktop?.enabled === undefined) a.desktop.enabled = await prompter.confirm('Desktop application (Tauri)?', false);
  if (a.desktop.enabled) await askDesktopIdentity(prompter, given, a);

  // The engine comes first: modules that do not support it (module.json `databases`) are then not offered.
  if (!given.database?.engine) {
    a.database.engine = await prompter.select('Database', Object.keys(DB_ENGINES).map((value) => ({ value, label: DB_ENGINE_LABELS[value] })), a.desktop.enabled ? 'sqlite' : 'selfhosted');
  }
  if (given.multiUser === undefined) {
    a.multiUser = !a.desktop.enabled && a.privateAccess && supportsDatabase(catalog.byId.get('user'), a.database.engine) && catalog.byId.has('user')
      ? await prompter.confirm('Multi-user application (accounts, login)?', false) : false;
  }
  if (!given.modules) a.modules = await selectFunctionalModules(prompter, catalog, a);
  await askModuleQuestions(prompter, catalog, a);
  if (given.localTrust === undefined) {
    // Asked last: modules may pull the user module in through "requires".
    a.localTrust = !resolveProject(catalog, a).ids.includes('user')
      && await prompter.confirm('Single-user local application (local trust mode: no admin key on this machine)?', a.desktop.enabled);
  }
  if (given.pwa?.enabled === undefined) a.pwa.enabled = await prompter.confirm('Installable app (PWA: manifest, service worker, install button)?', false);
  if (given.database?.redis === undefined) a.database.redis = await prompter.confirm('Redis?', false);
  if (!given.languages) a.languages = csv(await prompter.text('Languages (first = default)', 'fr,en'));
  return { answers: a, catalog };
}

/** Desktop questions (product name, identifier), asked only when the option is on and not given. */
async function askDesktopIdentity(prompter, given, a) {
  const defaults = resolveDesktop(a);
  if (!given.desktop?.productName) a.desktop.productName = await prompter.text('Desktop app name', defaults.productName);
  if (!given.desktop?.identifier) a.desktop.identifier = await prompter.text('Desktop app identifier (reverse domain, e.g. com.mycompany.myapp)', defaults.identifier);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
};
const runQuiet = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });

const randomPassword = () => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
const randomKeyB64 = () => randomBytes(32).toString('base64');

function writeIfAbsent(file, content, label = file) {
  if (existsSync(file)) {
    log.ok(`${label} already present — kept as-is.`);
    return false;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  log.ok(`${label} written.`);
  return true;
}

const GITIGNORE = `# OS / editor
.DS_Store
*.log
.vscode/*
!.vscode/extensions.json
.idea

# Node
node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build output
dist
dist-ssr
build
*.tsbuildinfo

# Env
.env*
!.env.example
*.local

# SQLite database files (DB_ENGINE=sqlite, DB_PATH=data/<project>.db)
back/data/

# Shared modules (materialized as symlinks by link-shared.mjs)
modules_shared

# Root-only scratch scripts; front/scripts and back/scripts are versioned.
/scripts/

# Generated for agents that do not follow @imports (scripts/update_common.sh)
/AGENTS.md
`;

const SHARED_DOC =
  'Generated by scripts/create-project.mjs (answers in project.config.json) — change it with scripts/add-module.mjs. Consumed by back/front link-shared.mjs, which symlinks each listed module into src/modules_shared/. Modules NOT listed are PRUNED. Listing "user" activates user management; without it the app runs anonymously (admin protected by ADMIN_TOKEN).';

function vendorLibs(root, sources, withPrivate) {
  const filter = (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src);
  for (const stack of ['back', 'front']) {
    const libs = path.join(root, stack, '.libs');
    const pub = path.join(libs, 'vx-public');
    mkdirSync(pub, { recursive: true });
    for (const entry of ['template', 'nest', 'react', 'tools']) {
      if (existsSync(path.join(sources.public, entry))) cpSync(path.join(sources.public, entry), path.join(pub, entry), { recursive: true, filter });
    }
    if (withPrivate && sources.private) cpSync(sources.private, path.join(libs, 'vx-private'), { recursive: true, filter });
    if (!existsSync(path.join(libs, 'apptemplate'))) symlinkSync('vx-public/template', path.join(libs, 'apptemplate'));
  }
  if (!existsSync(path.join(root, 'scripts'))) symlinkSync('front/.libs/apptemplate/scripts', path.join(root, 'scripts'));
}

function mountLibs(root, opts, answers, sources) {
  if (opts['vendor-libs']) {
    vendorLibs(root, sources, answers.privateAccess);
    log.ok('Libraries vendored (copies, --vendor-libs).');
    return;
  }
  run('bash', [path.join(SCRIPT_DIR, 'lib', 'libs.sh'), 'setup', answers.privateAccess ? '1' : '0'], { cwd: root });
}

function stackEnvDev(root, stack, answers, resolved, catalog, values) {
  const dir = path.join(root, stack);
  const exampleSrc = path.join(dir, '.libs', 'apptemplate', stack, '.env.example');
  const input = existsSync(exampleSrc) ? { template: readFileSync(exampleSrc, 'utf8'), catalog, resolved, stack, local: '' } : null;
  const text = input ? envExampleBody(input) : '';
  // Generated file (regenerated by build-package.mjs on every install/build): see renderEnvExample.
  writeIfAbsent(path.join(dir, '.env.example'), input ? renderEnvExample(input) : '', `${stack}/.env.example (blocks for: ${resolved.ids.join(', ')})`);
  const dev = path.join(dir, '.env.dev');
  if (existsSync(dev)) {
    log.ok(`${stack}/.env.dev already present — kept as-is.`);
    return;
  }
  writeFileSync(dev, applyEnvValues(text, values));
  log.ok(`${stack}/.env.dev written.`);
}

/** Default SQLite file, relative to back/ (resolved by nest/database/databases.ts). */
export const sqliteDbPath = (projectName) => `data/${projectName}.db`;

/** Version range of better-sqlite3 added to back/package.local.json for SQLite projects. */
export const BETTER_SQLITE3_VERSION = '^12.11.1';

/** Content of back/package.local.json: SQLite is a native dependency, so only SQLite projects get it. */
export function backPackageLocal(answers) {
  const pkg = { name: `${answers.projectName}-back`, version: '0.1.0' };
  if (answers.database.engine === 'sqlite') pkg.dependencies = { 'better-sqlite3': BETTER_SQLITE3_VERSION };
  return pkg;
}

export function backEnvValues(answers, resolved, fromAnswers) {
  const { back, front } = answers.ports;
  const values = {
    APP_ENV: 'dev',
    PROJECT_NAME: answers.projectName,
    NODE_PORT: back,
    FRONT_PORT: front,
    CLIENT_ORIGINS: `http://localhost:${front}`,
    CRYPT_DB_MASTER_KEY: randomKeyB64(),
    CRYPT_SESSION_PRIVATE_KEY: randomKeyB64(),
    DISABLE_TRANSPORT_CRYPTO: 'true',
  };
  if (answers.database.engine === 'selfhosted') {
    Object.assign(values, {
      DB_HOST: 'localhost', DB_PORT: back + 1, DB_USER: 'postgres', DB_PASSWORD: randomPassword(), DB_NAME: answers.projectName,
    });
  } else if (answers.database.engine === 'sqlite') {
    // DB_SCHEMA_MODE / DB_MIGRATIONS_RUN stay unset in dev (SQLite: synchronize); a desktop build gets its mode from `schema` in desktop.config.json.
    Object.assign(values, { DB_ENGINE: 'sqlite', DB_PATH: sqliteDbPath(answers.projectName) });
  } else {
    values.DB_ENGINE = DB_ENGINES[answers.database.engine];
  }
  if (answers.database.redis) values.REDIS_URL = 'redis://localhost:6379';
  if (!resolved.ids.includes('user')) values.ADMIN_TOKEN = randomBytes(32).toString('hex');
  // Local trust: the back refuses to start unless it listens on loopback only.
  if (answers.localTrust && !resolved.ids.includes('user')) Object.assign(values, { LOCAL_TRUST: 'true', HOST: '127.0.0.1' });
  return { ...values, ...fromAnswers.back };
}

function frontEnvValues(answers, fromAnswers) {
  const { back, front } = answers.ports;
  return {
    PROJECT_NAME: answers.projectName,
    VITE_PROJECT_NAME: answers.siteName,
    VITE_PROJECT_DESCRIPTION: answers.projectName,
    CLOUDFLARE_PAGES_PROJECT: answers.projectName,
    VITE_FRONT_URL: `http://localhost:${front}`,
    VITE_API_URL: '/api/v1',
    VITE_API_PORT: back,
    VITE_PORT: front,
    ...fromAnswers.front,
  };
}

/**
 * `back/src/locales/common.<lang>.json` must be a real file in every app (sync-common-locales only ADDS keys to an
 * existing one): seeded from the template's canonical subset, the project's own mount first, else this script's.
 * A language without a canonical file starts from the English one.
 */
function writeCommonLocales(root, answers) {
  const dir = path.join(root, 'back', 'src', 'locales');
  const sources = [path.join(root, 'back', '.libs', 'apptemplate', 'back', 'locales'), path.join(SCRIPT_DIR, '..', 'back', 'locales')];
  const sourceDir = sources.find((candidate) => existsSync(path.join(candidate, 'common.en.json')));
  if (!sourceDir) return log.warn('Canonical common.en.json not found — create back/src/locales/common.<lang>.json by hand.');
  mkdirSync(dir, { recursive: true });
  for (const lang of answers.languages) {
    const file = path.join(dir, `common.${lang}.json`);
    if (existsSync(file)) continue;
    const canonical = path.join(sourceDir, `common.${lang}.json`);
    writeFileSync(file, readFileSync(existsSync(canonical) ? canonical : path.join(sourceDir, 'common.en.json'), 'utf8'));
    if (!existsSync(canonical)) log.warn(`back/src/locales/common.${lang}.json copied from the English file — translate it.`);
  }
}

function writeLocales(root, answers) {
  writeCommonLocales(root, answers);
  const dir = path.join(root, 'back', 'src', 'locales');
  const template = path.join(dir, 'custom.en.json');
  if (!existsSync(template)) return;
  for (const lang of answers.languages) {
    const file = path.join(dir, `custom.${lang}.json`);
    if (!existsSync(file)) {
      writeFileSync(file, readFileSync(template, 'utf8'));
      log.warn(`back/src/locales/custom.${lang}.json copied from the English file — translate it.`);
    }
  }
  for (const lang of ['en', 'fr']) {
    if (!answers.languages.includes(lang)) rmSync(path.join(dir, `custom.${lang}.json`), { force: true });
  }
}

function patchDefaults(root, entries) {
  const file = path.join(root, 'back', 'src', 'config', 'defaultConfig.ts');
  if (!existsSync(file)) return;
  const source = readFileSync(file, 'utf8');
  if (!/defaultConfigEntries: DefaultConfigEntry\[\] = \[\];/.test(source)) {
    log.ok('back/src/config/defaultConfig.ts already customized — kept as-is.');
    return;
  }
  writeFileSync(file, patchDefaultConfig(source, entries));
  log.ok(`back/src/config/defaultConfig.ts seeded (${entries.length} entries).`);
}

function finishProject({ root, opts, answers, resolved, catalog }) {
  const sh = (cmd, args, options = {}) => run(cmd, args, { cwd: root, ...options });
  writeIfAbsent(path.join(root, '.gitignore'), GITIGNORE, '.gitignore');

  const docs = path.join(root, 'front', '.libs', 'apptemplate', 'scripts', 'project-docs.mjs');
  if (existsSync(docs)) sh('node', [docs, 'ensure', root]);

  const fromAnswers = buildEnvFromAnswers(catalog, answers, resolved.ids);
  stackEnvDev(root, 'back', answers, resolved, catalog, backEnvValues(answers, resolved, fromAnswers));
  stackEnvDev(root, 'front', answers, resolved, catalog, frontEnvValues(answers, fromAnswers));
  sh('node', ['scripts/link-config.mjs', root]);

  writeIfAbsent(path.join(root, 'shared-modules.json'), `${JSON.stringify(buildSharedModules(resolved, SHARED_DOC), null, 2)}\n`, 'shared-modules.json');
  const saved = { ...answers, desktop: answers.desktop.enabled ? resolveDesktop(answers) : { enabled: false }, resolved: resolved.perStack };
  writeFileSync(path.join(root, 'project.config.json'), `${JSON.stringify(saved, null, 2)}\n`);
  log.ok('project.config.json written.');

  writeIfAbsent(path.join(root, 'front', 'package.local.json'), `${JSON.stringify(frontPackageLocal(answers), null, 2)}\n`, 'front/package.local.json');
  writeIfAbsent(path.join(root, 'back', 'package.local.json'), `${JSON.stringify(backPackageLocal(answers), null, 2)}\n`, 'back/package.local.json');

  if (existsSync(path.join(root, 'front', 'src', 'main.tsx')) && existsSync(path.join(root, 'back', 'src', 'main.ts'))) {
    log.ok('Base components already copied — skipped (apply-component-templates stays one-shot).');
  } else {
    log.info('Copying base UI components / minimal back skeleton (one-shot)...');
    sh('node', ['scripts/apply-component-templates.mjs', root, '--site-name', answers.siteName, '--entity-name', answers.entityName,
      '--contact-email', answers.contactEmail, '--project-name', answers.projectName]);
  }
  patchDefaults(root, buildConfigEntries(catalog, answers, resolved.ids));
  writeLocales(root, answers);
  if (answers.desktop.enabled) {
    const copied = installDesktop(root, path.join(root, 'front', '.libs', 'apptemplate'), answers, { keepExisting: true });
    log.ok(`Desktop shell: ${copied.length} files copied (desktop/, .github/workflows/build-desktop.yml), scripts desktop:dev and desktop:build added to back/package.local.json.`);
  }

  for (const stack of ['back', 'front']) {
    sh('node', ['.libs/apptemplate/scripts/build-package.mjs', stack], { cwd: path.join(root, stack) });
    sh('node', ['.libs/apptemplate/scripts/link-shared.mjs', stack], { cwd: path.join(root, stack) });
  }
  if (opts['no-install']) {
    log.warn('--no-install: npm install skipped.');
  } else {
    for (const stack of ['front', 'back']) {
      const r = spawnSync('npm', ['install'], { cwd: path.join(root, stack), stdio: 'inherit' });
      if (r.status !== 0) log.warn(`${stack}: npm install failed — fix manually with 'cd ${stack} && npm install'.`);
    }
  }
  commitAndPublish({ root, opts, answers });
}

function commitAndPublish({ root, opts, answers }) {
  if (opts['no-commit']) return;
  const hasHead = runQuiet('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status === 0;
  if (hasHead && !runQuiet('git', ['status', '--porcelain'], { cwd: root }).stdout.trim()) {
    log.ok('Nothing to commit — scaffold already committed.');
  } else {
    run('git', ['add', '-A'], { cwd: root });
    run('git', ['commit', '-q', '-m', hasHead ? 'Resume scaffold from WebAppTemplate' : 'Initial scaffold from WebAppTemplate'], { cwd: root });
    log.ok('Commit created.');
  }
  if (opts['no-github'] || process.env.VX_SKIP_GITHUB === '1') {
    log.warn('GitHub repository creation skipped.');
    return;
  }
  const gh = runQuiet('gh', ['--version']);
  const repo = `${answers.githubOrg}/${answers.projectName}`;
  if (gh.status !== 0) {
    log.warn('gh CLI not found — create the remote manually: git remote add origin <url> && git push -u origin main');
  } else if (runQuiet('gh', ['repo', 'view', repo]).status === 0) {
    log.info(`GitHub repository ${repo} already exists — reusing it.`);
    if (runQuiet('git', ['remote', 'get-url', 'origin'], { cwd: root }).status !== 0) {
      run('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: root });
    }
    if (runQuiet('git', ['push', '-u', 'origin', 'main'], { cwd: root, stdio: 'inherit' }).status !== 0) log.warn('git push failed — check the remote state manually.');
  } else if (runQuiet('gh', ['repo', 'create', repo, '--private', '--source=.', '--push'], { cwd: root, stdio: 'inherit' }).status !== 0) {
    log.warn('gh repo create failed — create the remote manually and push.');
  }
}

// ---------------------------------------------------------------------------
// Plan / summary
// ---------------------------------------------------------------------------

export function renderPlan(answers, resolved, catalog, root) {
  const lines = [
    `Project         ${answers.projectName} (${answers.siteName}) — ${root}`,
    `Access          vx-public${answers.privateAccess ? ' + vx-private' : ''}`,
    `Mode            ${resolved.ids.includes('user') ? 'multi-user (user module)' : answers.localTrust ? 'local trust (LOCAL_TRUST=true, HOST=127.0.0.1; ADMIN_TOKEN still generated for non-local clients)' : 'anonymous (ADMIN_TOKEN generated in back/.env.dev)'}`,
    `Back modules    ${resolved.perStack.nest.join(', ')}`,
    `Front modules   ${resolved.perStack.react.join(', ')}`,
  ];
  if (resolved.added.length) lines.push(`Added by requires: ${resolved.added.join(', ')}`);
  const dbLine = answers.database.engine === 'sqlite' ? `sqlite (${sqliteDbPath(answers.projectName)}, better-sqlite3 added to back/package.local.json)` : answers.database.engine;
  lines.push(`Database        ${dbLine}${answers.database.redis ? ' + Redis' : ''}`, `Languages       ${answers.languages.join(', ')}`);
  const entries = buildConfigEntries(catalog, answers, resolved.ids);
  const pwa = resolvePwa(answers);
  lines.push(`PWA             ${pwa.enabled ? `yes ("${pwa.name}" / "${pwa.shortName}", theme ${pwa.themeColor}, background ${pwa.backgroundColor}; vite-plugin-pwa added to front/package.local.json)` : 'no'}`);
  const desktop = resolveDesktop(answers);
  lines.push(`Desktop         ${desktop.enabled ? `yes ("${desktop.productName}", ${desktop.identifier}; desktop/, .github/workflows/build-desktop.yml, scripts desktop:dev and desktop:build in back/package.local.json)` : 'no'}`);
  lines.push(`Seeded config   ${entries.map((e) => e.name).join(', ')}`);
  lines.push(`Files           shared-modules.json, project.config.json, back/.env.dev + .env.example, front/.env.dev + .env.example, back/src/config/defaultConfig.ts, back/src/locales/{common,custom}.<lang>.json, front/public/{robots.txt,_redirects,_headers,favicon.svg}${pwa.enabled ? ', front/pwa.plugin.ts, front/pwa-assets.config.ts, front/src/sw.ts' : ''}`);
  return lines.join('\n');
}

const SUMMARY = (a, root) => `
============================================================
  ${a.projectName} scaffolded at ${root}

  Needed customizations before shipping:
  - back/.env.dev — check the generated values; a real back/.env for preprod/prod
  - front/.env.dev — fill in the keys that were left empty (VITE_REOWN_PROJECT_ID...)
  - front/src/theme.ts — replace the neutral placeholder color palette
  - back/src/locales/custom.{lang}.json — replace placeholder landing/legal copy
  - front/src/components/pages/{Confidentiality,LegalMentions,UsageConditions}.tsx — legal text for ${a.entityName || 'your entity'}
  - FEATURES.md — create it and track the application capabilities
${a.pwa?.enabled ? `  - PWA: replace front/public/favicon.svg with your logo, then run "npm run pwa:icons" in front/ (generates the manifest icons)
` : ''}${a.desktop?.enabled ? `  - desktop: check desktop/desktop.config.json (identifier "${a.desktop.identifier}" names the OS data folder), run "tauri icon <logo>" in desktop/ for the app icons, see desktop/README.md
` : ''}  - add a module later: node scripts/add-module.mjs <id>
============================================================
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv) {
  const opts = parseCli(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const fileAnswers = opts.answers ? JSON.parse(readFileSync(path.resolve(opts.answers), 'utf8')) : {};
  const nonInteractive = Boolean(opts.yes || opts.answers);
  const prompter = new Prompter(!nonInteractive); // piped stdin works too; EOF falls back to defaults
  const given = mergeAnswers(fileAnswers, answersFromCli(opts));
  if (given.commerce !== undefined) {
    given.questions = { ...(given.questions ?? {}), commerce: given.commerce };
    delete given.commerce;
  }
  const tmpDirs = [];
  try {
    const parent = path.resolve(opts.positional[1] ?? opts['parent-dir'] ?? process.cwd());
    let root = null;
    let catalog = null;
    const publicDir = path.resolve(opts['public-dir'] ?? REPO_ROOT);

    const catalogFor = async (a) => {
      if (!a.projectName) throw new Error('a project name is required');
      root = path.join(parent, a.projectName);
      if (opts['dry-run'] || opts['vendor-libs']) {
        if (!hasLib(publicDir)) throw new Error(`--public-dir ${publicDir} has no nest/ and react/`);
        const privateDir = a.privateAccess ? privateCatalogDir(opts, tmpDirs) : null;
        a.sources = { public: publicDir, private: privateDir };
        catalog = loadCatalog(a.sources);
        return catalog;
      }
      if (existsSync(root) && !existsSync(path.join(root, '.git')) && readdirSync(root).length) {
        throw new Error(`${root} already exists, is not empty and is not a git repo — check it manually.`);
      }
      mkdirSync(root, { recursive: true });
      if (!existsSync(path.join(root, '.git'))) run('git', ['init', '-q', '-b', 'main'], { cwd: root });
      mountLibs(root, opts, a, a.sources ?? {});
      catalog = loadCatalog({ public: path.join(root, 'back', '.libs', 'vx-public'), private: a.privateAccess ? path.join(root, 'back', '.libs', 'vx-private') : null });
      return catalog;
    };

    const withCliAnswers = (innerCatalogFor) => async (a) => {
      const found = await innerCatalogFor(a);
      const known = new Map([...found.byId.values()].flatMap((m) => m.questions.map((q) => [q.id, q])));
      for (const pair of opts.answer) {
        const [id, ...rest] = pair.split('=');
        a.questions[id] = parseAnswerValue(rest.join('='), known.get(id));
      }
      return found;
    };
    const interactiveStart = prompter.interactive;
    if (interactiveStart) log.info('Creating a new project (Enter accepts the default shown in brackets).');
    const { answers: collected } = await collectAnswers({ opts, given, prompter, catalogFor: withCliAnswers(catalogFor) });
    const sources = collected.sources;
    delete collected.sources;
    const answers = withQuestionDefaults(catalog, collected);
    const errors = validateAnswers(answers, catalog);
    if (errors.length) {
      for (const e of errors) console.error(`\x1b[1;31m✖\x1b[0m  ${e}`);
      return 2;
    }
    const resolved = resolveProject(catalog, answers);
    console.log(`\n${renderPlan(answers, resolved, catalog, root)}\n`);
    if (opts['dry-run']) {
      log.info('--dry-run: nothing written.');
      return 0;
    }
    if (prompter.interactive && !(await prompter.confirm('Create the project?', true))) {
      log.warn('Cancelled (libraries may already be mounted in the project directory).');
      return 1;
    }
    if (opts['vendor-libs']) mountLibs(root, opts, answers, sources);
    mkdirSync(path.join(root, 'front', 'src'), { recursive: true });
    mkdirSync(path.join(root, 'back', 'src'), { recursive: true });
    if (!existsSync(path.join(root, '.git'))) run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    finishProject({ root, opts, answers, resolved, catalog });
    console.log(SUMMARY(answers, root));
    return 0;
  } finally {
    prompter.close();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`\x1b[1;31m✖\x1b[0m  ${error.message}`); process.exitCode = 1; },
  );
}
