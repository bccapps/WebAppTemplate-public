/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Tests of the `--harden` flag (run.sh / deploy-full.sh / migrate-db.sh / restart.sh -> lib/compose-file.sh) against the historical
// COMPOSE_FILE_NAME=scripts/docker-compose-hardened.yml variable. Offline: the resolver is sourced from bash in a throw-away
// directory, and the scripts run against the stub binaries of deploy-test-kit.mjs (no Docker, no host, no network).
//
// Run: node --test scripts/harden-flag.test.mjs   (needs bash and python3)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SCRIPTS_DIR, makeProject } from './deploy-test-kit.mjs';

const HARDENED = 'scripts/docker-compose-hardened.yml';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const indexOfLine = (lines, re) => lines.findIndex((l) => re.test(l));

// Variables the hardened compose file requires (docker-compose-hardened.yml), WITHOUT COMPOSE_FILE_NAME: the flag must be enough.
// `COMPOSE_FILE_NAME=` empties the line the kit writes (an empty value counts as unset).
const HARDENED_VARS = [
  'FRONT_HOSTS=10.0.0.1',
  'HARDEN_RUNTIME_UID=61000',
  'HARDEN_RUNTIME_GID=61000',
  'HARDEN_SUBNET=10.231.73.0/24',
  'HARDEN_FRONT_IP=10.231.73.10',
  'HARDEN_BACK_LB_IP=10.231.73.11',
  'HARDEN_BACK_LB_REALIP="set_real_ip_from 198.51.100.7;"',
  'REDIS_PORT=4733',
  `REDIS_PASSWORD=FAKE${'redis'}`,
];
const NO_NAME = ['COMPOSE_FILE_NAME=', ...HARDENED_VARS].join('\n');
const WITH_NAME = [`COMPOSE_FILE_NAME=${HARDENED}`, ...HARDENED_VARS].join('\n');

const hardenedSource = readFileSync(path.join(SCRIPTS_DIR, 'docker-compose-hardened.yml'), 'utf8')
  .replaceAll('../back', './back').replaceAll('../front', './front');

// ---------------------------------------------------------------------------------------------------------------------------------
// The resolver itself (lib/compose-file.sh), sourced in a project directory that has (or lacks) the hardened file.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Runs `snippet` after sourcing the resolver, in a temp project dir; `withFile` = the hardened compose file exists there. */
function bash(snippet, { env = {}, withFile = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-'));
  try {
    if (withFile) {
      mkdirSync(path.join(root, 'scripts'));
      writeFileSync(path.join(root, HARDENED), '# fake\n');
    }
    const clean = { PATH: process.env.PATH, HOME: root };
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${SCRIPTS_DIR}/lib/compose-file.sh"; ${snippet}`], {
      cwd: root, env: { ...clean, ...env }, encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const RESOLVE = 'resolve_compose_file_path "scripts/docker-compose.yml"; printf "%s|%s" "${COMPOSE_FILE_PATH}" "${COMPOSE_FILE_NAME:-}"';

test('resolver: default case (no flag, no variable, or the variable alone) is byte-identical to the former expression', () => {
  const cases = [undefined, 'scripts/docker-compose-cloud.yml', './scripts/docker-compose-hardened.yml', 'scripts/docker-compose-hardened.yml', './x/y.yml'];
  for (const name of cases) {
    const env = name === undefined ? {} : { COMPOSE_FILE_NAME: name };
    // the expression deploy-full.sh / migrate-db.sh used before the resolver existed
    const legacy = bash('P="${COMPOSE_FILE_NAME:-scripts/docker-compose.yml}"; P="${P#./}"; printf "%s" "${P}"', { env });
    const now = bash(RESOLVE, { env });
    assert.equal(now.status, 0, now.err);
    assert.equal(now.out.split('|')[0], legacy.out, `COMPOSE_FILE_NAME=${name}`);
    // the variable is left untouched without the flag
    assert.equal(now.out.split('|')[1], name ?? '');
  }
  // the hardened file does not even have to exist when the flag is not used
  assert.equal(bash(RESOLVE, { withFile: false }).out, 'scripts/docker-compose.yml|');
  // DEPLOY_HARDEN=0 / off / empty = not asked
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.equal(bash(RESOLVE, { env: { DEPLOY_HARDEN: v }, withFile: false }).out, 'scripts/docker-compose.yml|', `DEPLOY_HARDEN='${v}'`);
  }
});

test('resolver: the flag resolves to the same path as the environment variable', () => {
  const viaVar = bash(RESOLVE, { env: { COMPOSE_FILE_NAME: HARDENED } });
  const viaFlag = bash(RESOLVE, { env: { DEPLOY_HARDEN: '1' } });
  assert.equal(viaVar.status, 0, viaVar.err);
  assert.equal(viaFlag.status, 0, viaFlag.err);
  assert.equal(viaFlag.out.split('|')[0], viaVar.out.split('|')[0]);
  assert.equal(viaFlag.out.split('|')[0], HARDENED);
  assert.equal(viaFlag.out.split('|')[1], HARDENED, 'COMPOSE_FILE_NAME exported for the scripts launched afterwards');
  // flag + the same file named by the variable (with or without ./) is redundant, not a conflict
  for (const name of [HARDENED, `./${HARDENED}`]) {
    const both = bash(RESOLVE, { env: { DEPLOY_HARDEN: 'true', COMPOSE_FILE_NAME: name } });
    assert.equal(both.status, 0, both.err);
    assert.equal(both.out.split('|')[0], HARDENED);
  }
});

test('resolver: --harden with a missing hardened file is refused, never replaced by the default compose file', () => {
  const r = bash(RESOLVE, { env: { DEPLOY_HARDEN: '1' }, withFile: false });
  assert.equal(r.status, 1);
  assert.equal(r.out, '', 'nothing resolved');
  assert.match(r.err, /--harden needs scripts\/docker-compose-hardened\.yml .* does not exist/);
  assert.match(r.err, /Not falling back to the default compose file/);
});

test('resolver: --harden with another COMPOSE_FILE_NAME is refused and says which', () => {
  const r = bash(RESOLVE, { env: { DEPLOY_HARDEN: '1', COMPOSE_FILE_NAME: 'scripts/docker-compose-cloud.yml' } });
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /--harden selects scripts\/docker-compose-hardened\.yml but COMPOSE_FILE_NAME already sets COMPOSE_FILE_NAME=scripts\/docker-compose-cloud\.yml/);
});

test('resolver: an invalid DEPLOY_HARDEN value is refused (never read as "off")', () => {
  const r = bash(RESOLVE, { env: { DEPLOY_HARDEN: 'maybe' } });
  assert.equal(r.status, 1);
  assert.match(r.err, /DEPLOY_HARDEN='maybe' is not valid/);
});

test('resolver: cf_peek_env_value reads the last COMPOSE_FILE_NAME of an env file like `source` would', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-'));
  try {
    const file = path.join(root, 'env');
    writeFileSync(file, [
      '# COMPOSE_FILE_NAME=scripts/commented.yml', 'COMPOSE_FILE_NAME=scripts/first.yml', 'OTHER_COMPOSE_FILE_NAME=nope',
      'export COMPOSE_FILE_NAME="scripts/last.yml"   # trailing comment', '',
    ].join('\n'));
    const r = spawnSync('bash', ['-c', `source "${SCRIPTS_DIR}/lib/compose-file.sh"; cf_peek_env_value "${file}"; cf_peek_env_value "${root}/missing"`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'scripts/last.yml');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// run.sh -> deploy-full.sh end to end on the stubs (the compose file that reaches the build context is the proof).
// ---------------------------------------------------------------------------------------------------------------------------------

/** The compose file staged by a successful deploy (KEEP_BUILD_CONTEXT=1), as the build context holds it. */
function stagedCompose(out) {
  const ctx = strip(out).match(/Build context staged at (\S+)/)[1];
  return readFileSync(path.join(ctx, 'docker-compose.yml'), 'utf8');
}

const deploy = (p, args, env = {}) => p.run(args, { KEEP_BUILD_CONTEXT: '1', ...env });

test('run.sh prod --harden deploys the hardened compose file, exactly like COMPOSE_FILE_NAME in back/.env', () => {
  const viaVar = makeProject({ engine: 'postgres', extraBackEnv: WITH_NAME });
  const viaFlag = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    const a = deploy(viaVar, ['prod', '--no-update-common', '--target=back']);
    const b = deploy(viaFlag, ['prod', '--harden', '--no-update-common', '--target=back']);
    assert.equal(a.status, 0, a.out);
    assert.equal(b.status, 0, b.out);
    assert.equal(stagedCompose(a.out), hardenedSource, 'variable: hardened file staged');
    assert.equal(stagedCompose(b.out), stagedCompose(a.out), 'flag: same file as the variable');
    assert.notEqual(stagedCompose(b.out), '', 'not empty');
  } finally { viaVar.cleanup(); viaFlag.cleanup(); }
});

test('run.sh without the flag and without the variable still deploys the default compose file', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: 'COMPOSE_FILE_NAME=' });
  try {
    const r = deploy(p, ['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const defaultSource = readFileSync(path.join(SCRIPTS_DIR, 'docker-compose.yml'), 'utf8').replaceAll('../back', './back').replaceAll('../front', './front');
    assert.equal(stagedCompose(r.out), defaultSource);
    assert.notEqual(stagedCompose(r.out), hardenedSource);
  } finally { p.cleanup(); }
});

test('run.sh: --harden is accepted at any position among the options (migration step included)', () => {
  const variants = [
    ['prod', '--harden', '--migrate', '--no-update-common', '--target=back'],
    ['prod', '--migrate', '--no-update-common', '--target=back', '--harden'],
    ['--harden', 'prod', '--migrate', '--no-update-common', '--target=back'],
    ['prod', '--no-update-common', '--harden', '--migrate', '--target=back'],
  ];
  for (const args of variants) {
    const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
    try {
      const r = deploy(p, args);
      assert.equal(r.status, 0, `${args.join(' ')}\n${r.out}`);
      assert.equal(stagedCompose(r.out), hardenedSource, args.join(' '));
      const lines = p.logLines();
      assert.ok(indexOfLine(lines, /^migrate-db\.sh/) >= 0, `${args.join(' ')}: migrations ran`);
      assert.equal(indexOfLine(lines, /^update_common\.sh/), -1);
      assert.doesNotMatch(lines.find((l) => l.startsWith('migrate-db.sh')), /--harden/, '--harden is not forwarded as an argument');
    } finally { p.cleanup(); }
  }
});

test('run.sh preprod --harden uses the preprod env file and the hardened file', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    const r = deploy(p, ['preprod', '--harden', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.equal(stagedCompose(r.out), hardenedSource);
  } finally { p.cleanup(); }
});

test('run.sh --harden conflicting with COMPOSE_FILE_NAME of the env file: refused before the library sync, nothing deployed', () => {
  // the kit's back/.env names scripts/docker-compose.yml (postgres)
  const p = makeProject({ engine: 'postgres', extraBackEnv: HARDENED_VARS.join('\n') });
  try {
    const r = p.run(['prod', '--harden', '--migrate']);
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /--harden selects scripts\/docker-compose-hardened\.yml but \.\/back\/\.env already sets COMPOSE_FILE_NAME=scripts\/docker-compose\.yml/);
    const lines = p.logLines();
    assert.equal(lines.length, 0, `no command ran at all: ${lines.join(' | ')}`);
  } finally { p.cleanup(); }
});

test('run.sh --harden conflicting with COMPOSE_FILE_NAME of the environment: refused, nothing deployed', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    const r = p.run(['prod', '--harden', '--no-update-common'], { COMPOSE_FILE_NAME: 'scripts/docker-compose-cloud.yml' });
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /already sets COMPOSE_FILE_NAME=scripts\/docker-compose-cloud\.yml/);
    assert.match(strip(r.out), /the environment/);
    assert.equal(p.logLines().length, 0);
  } finally { p.cleanup(); }
});

test('run.sh --harden with the hardened file missing: refused, no fallback to the default compose file', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    rmSync(path.join(p.root, HARDENED)); // the project's symlink to the template file
    assert.ok(!existsSync(path.join(p.root, HARDENED)));
    const r = p.run(['prod', '--harden']);
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /--harden needs scripts\/docker-compose-hardened\.yml/);
    assert.equal(p.logLines().length, 0, 'no sync, no build, no deploy');
  } finally { p.cleanup(); }
});

test('run.sh: the variable alone keeps working when the hardened file is the one named (compatibility)', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: WITH_NAME });
  try {
    const r = deploy(p, ['prod', '--no-update-common', '--target=back'], { COMPOSE_FILE_NAME: HARDENED });
    assert.equal(r.status, 0, r.out);
    assert.equal(stagedCompose(r.out), hardenedSource);
  } finally { p.cleanup(); }
});

test('run.sh: --harden with another command than preprod|prod|rollback is refused', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    for (const args of [['dev', '--harden'], ['--harden', 'stop'], ['status', '--harden']]) {
      const r = p.run(args);
      assert.equal(r.status, 1, `${args.join(' ')}\n${r.out}`);
      assert.match(strip(r.out), /--harden only applies to preprod, prod and rollback/);
    }
    assert.equal(p.logLines().length, 0);
  } finally { p.cleanup(); }
});

test('run.sh rollback --harden: accepted (reaches the rollback), refused on conflict', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    // no :previous image seeded: the real deploy-full.sh --rollback answers, so the flag was accepted and the file resolved
    let r = p.run(['rollback', 'prod', '--harden', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no testapp_back:previous image/);
    assert.doesNotMatch(r.out, /Unknown rollback option/);
  } finally { p.cleanup(); }
  const c = makeProject({ engine: 'postgres', extraBackEnv: HARDENED_VARS.join('\n') });
  try {
    const r = c.run(['rollback', 'prod', '--harden', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /--harden selects scripts\/docker-compose-hardened\.yml but \.\/back\/\.env already sets/);
    assert.match(strip(r.out), /^(?!.*previous image)/s);
    assert.equal(c.logLines().length, 0);
  } finally { c.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// --help / usage texts
// ---------------------------------------------------------------------------------------------------------------------------------

test('--help of run.sh lists --harden and its equivalence with COMPOSE_FILE_NAME', () => {
  const p = makeProject();
  try {
    for (const args of [['--help'], ['help'], ['-h']]) {
      const r = p.run(args);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /--harden/);
      assert.match(r.stdout, /scripts\/docker-compose-hardened\.yml/);
      assert.match(r.stdout, /COMPOSE_FILE_NAME=scripts\/docker-compose-hardened\.yml/);
    }
    // no command at all prints the usage too (exit 1, as before)
    const none = p.run([]);
    assert.equal(none.status, 1);
    assert.match(none.stdout, /--harden/);
  } finally { p.cleanup(); }
});

test('--help of deploy-full.sh, migrate-db.sh and restart.sh list --harden', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-'));
  try {
    // whole-directory link: SCRIPT_DIR keeps the link path, so PROJECT_ROOT is the temp dir
    symlinkSync(SCRIPTS_DIR, path.join(root, 'scripts'));
    for (const script of ['deploy-full.sh', 'migrate-db.sh', 'restart.sh']) {
      const r = spawnSync('bash', [path.join(root, 'scripts', script), '--help'], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, `${script}: ${r.stderr}`);
      assert.match(r.stdout, /--harden/, script);
      assert.match(r.stdout, /docker-compose-hardened\.yml/, script);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The scripts that parse the flag themselves (direct use), on the stubs.
// ---------------------------------------------------------------------------------------------------------------------------------

test('deploy-full.sh --harden (direct): hardened file, same as the variable; conflict refused', () => {
  const ok = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    const r = ok.run(['--harden', '--target=back'], { KEEP_BUILD_CONTEXT: '1' }, 'deploy-full.sh');
    assert.equal(r.status, 0, r.out);
    assert.equal(stagedCompose(r.out), hardenedSource);
  } finally { ok.cleanup(); }
  const bad = makeProject({ engine: 'postgres', extraBackEnv: HARDENED_VARS.join('\n') });
  try {
    const r = bad.run(['--harden', '--target=back'], {}, 'deploy-full.sh');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--harden selects scripts\/docker-compose-hardened\.yml but COMPOSE_FILE_NAME already sets COMPOSE_FILE_NAME=scripts\/docker-compose\.yml/);
    assert.equal(indexOfLine(bad.logLines(), /compose .* (build|up) /), -1, 'nothing built or started');
  } finally { bad.cleanup(); }
});

test('migrate-db.sh and restart.sh (real scripts): --harden conflict refused, flag-less behaviour unchanged', () => {
  const p = makeProject({ engine: 'postgres', extraBackEnv: HARDENED_VARS.join('\n') });
  try {
    // the real scripts, through a whole-directory link (the kit replaces migrate-db.sh by a stub in p.root/scripts)
    symlinkSync(SCRIPTS_DIR, path.join(p.root, 'realscripts'));
    const run = (script, args, env = {}) => {
      const r = spawnSync('bash', [path.join(p.root, 'realscripts', script), ...args], {
        cwd: p.root, encoding: 'utf8', timeout: 60000, env: {
          PATH: `${path.join(p.root, '.stubs')}:${process.env.PATH}`, HOME: p.root, TMPDIR: p.root, STUB_LOG: p.log, STUB_STATE: p.state, ...env,
        },
      });
      return { status: r.status, out: strip(r.stdout + r.stderr) };
    };
    const conflict = /--harden selects scripts\/docker-compose-hardened\.yml but COMPOSE_FILE_NAME already sets COMPOSE_FILE_NAME=scripts\/docker-compose\.yml/;
    const m = run('migrate-db.sh', ['--harden']);
    assert.equal(m.status, 1, m.out);
    assert.match(m.out, conflict);
    const r = run('restart.sh', ['prod', '--harden']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, conflict);
    assert.equal(indexOfLine(p.logLines(), /compose .* (up|rm) /), -1, 'nothing restarted');

    // without the flag the variable of back/.env is read as before: the restart reaches `docker compose up` on scripts/docker-compose.yml
    const plain = run('restart.sh', ['prod']);
    assert.equal(plain.status, 0, plain.out);
    assert.ok(indexOfLine(p.logLines(), /compose -f scripts\/docker-compose\.yml .* up -d --no-build/) >= 0, p.logLines().join('\n'));
  } finally { p.cleanup(); }

  // flag on an env file that does not name any compose file: restart uses the hardened one
  const q = makeProject({ engine: 'postgres', extraBackEnv: NO_NAME });
  try {
    symlinkSync(SCRIPTS_DIR, path.join(q.root, 'realscripts'));
    const r = spawnSync('bash', [path.join(q.root, 'realscripts', 'restart.sh'), 'prod', '--harden'], {
      cwd: q.root, encoding: 'utf8', timeout: 60000, env: {
        PATH: `${path.join(q.root, '.stubs')}:${process.env.PATH}`, HOME: q.root, TMPDIR: q.root, STUB_LOG: q.log, STUB_STATE: q.state,
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(indexOfLine(q.logLines(), /compose -f scripts\/docker-compose-hardened\.yml .* up -d --no-build/) >= 0, q.logLines().join('\n'));
  } finally { q.cleanup(); }
});
