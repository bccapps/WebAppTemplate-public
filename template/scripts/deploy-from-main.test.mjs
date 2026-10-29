/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Tests of DEPLOY_FROM_MAIN=true (deploy-full.sh -> lib/deploy-from-main.sh) with REAL git: local bare origins (an app, a
// library submodule with a nested submodule), a working copy on `dev` with committed, staged, uncommitted and untracked
// changes, a stash, ignored inputs, node_modules, a library mount past what main records, an unpushed local main and a
// newer origin/main. docker, ssh, scp, rsync, npm... are the stubs of deploy-versions.test.mjs (read from that file):
// nothing ever reaches a host. Checks: the working copy is byte-identical afterwards, the clean tree is exactly
// origin/main with the submodule commits main records, inputs are staged, the exit code is the inner deploy's, the
// temporary tree is removed on success, failure, Ctrl-C, SIGHUP and SIGTERM.
//
// Run: node --test scripts/deploy-from-main.test.mjs   (needs bash, python3, git >= 2.29; skipped otherwise)
//      DFM_DEBUG=1 prints the deploy output of the main scenarios.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// vx-public commit whose deploy-full.sh still switched branches (stash + checkout): a project's main may record it.
const OLD_SCRIPT_COMMIT = '3e211b688b3531acfc0dee56aa20cd450b9da93a';

/** Why the suite cannot run here (false when it can): --no-write-fetch-head needs git 2.29. */
function missingTools() {
  for (const tool of ['bash', 'python3']) {
    if (spawnSync(tool, ['--version'], { encoding: 'utf8' }).error) return `${tool} not installed`;
  }
  const v = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (v.error) return 'git not installed';
  const m = /(\d+)\.(\d+)/.exec(v.stdout);
  if (!m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 29)) return `git >= 2.29 needed (${v.stdout.trim()})`;
  return false;
}
const SKIP = missingTools();
const dfmTest = (name, fn) => test(name, { skip: SKIP }, fn);

// Stubs shared with deploy-versions.test.mjs (copied from its STUBS object, so both suites fake hosts the same way). git
// is NOT stubbed here; npm logs its directory and `npm run build` makes a dist.
const harness = readFileSync(path.join(SCRIPTS_DIR, 'deploy-versions.test.mjs'), 'utf8');
const stubBody = (name) => {
  const m = harness.match(new RegExp(`\\n  ${name}: \`([\\s\\S]*?)\`,\\n`));
  if (!m) throw new Error(`stub ${name} not found in deploy-versions.test.mjs`);
  return new Function(`return \`${m[1]}\`;`)(); // eslint-disable-line no-new-func
};
const STUBS = {
  docker: stubBody('docker'), ssh: stubBody('ssh'), scp: stubBody('scp'), rsync: stubBody('rsync'),
  npm: '#!/usr/bin/env bash\necho "npm $* @ $(pwd -P)" >> "$STUB_LOG"\nif [ "$1 $2" = "run build" ]; then mkdir -p dist && echo built > dist/main.js; fi\nexit 0\n',
  npx: '#!/usr/bin/env bash\necho "npx $*" >> "$STUB_LOG"\nexit 0\n',
  curl: '#!/usr/bin/env bash\nexit 0\n',
  envsubst: '#!/usr/bin/env bash\ncat\n',
};

function write(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

function makeEnv(base) {
  const home = path.join(base, 'home');
  const bin = path.join(base, 'stubs');
  const tmp = path.join(base, 'tmp');
  const state = path.join(base, 'stub-state');
  for (const d of [home, bin, tmp, state]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) write(path.join(bin, name), body, 0o755);
  const gitconfig = path.join(home, '.gitconfig');
  write(gitconfig, '[user]\n\tname = T\n\temail = t@example.com\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  const log = path.join(base, 'stub.log');
  writeFileSync(log, '');
  return {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    STUB_LOG: log, STUB_STATE: state, LANG: 'C', GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd, args, env, opts = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} @${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

const FAKE_DEPLOY = `#!/usr/bin/env bash
# main's own deploy-full.sh in the "fake child" scenario: records what it receives, then exits with FAKE_RC.
stack_install_hash() {
  { cat "$1/package.json" "$1/package-lock.json" 2>/dev/null; node --version; } \\
    | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}
rec="$FAKE_RECORD"
{
  echo "PWD=$(pwd -P)"
  echo "SCRIPT=$0"
  echo "ARGS=$*"
  for v in DEPLOY_FROM_MAIN DEPLOY_FROM_MAIN_TREE DEPLOY_LIBS_SYNCED DEPLOY_REVISION BACK_ENV_FILE FRONT_ENV_FILE DEPLOY_TIMINGS; do echo "$v=\${!v:-}"; done
  for s in back front; do st="$s/node_modules/.vx-deploy-install"
    if [ -f "$st" ] && [ "$(cat "$st")" = "$(stack_install_hash "$s")" ]; then echo "NPM_$s=skip"; else echo "NPM_$s=install"; fi
  done
  echo "STATUS<<"; git status --porcelain --ignored=no; echo ">>"
} > "$rec"
mkdir -p "$rec.tree" && /bin/cp -RP . "$rec.tree/" && rm -rf "$rec.tree/.git"
git submodule status --recursive > "$rec.subs"
if [ -n "\${FAKE_SLEEP:-}" ]; then echo ready > "$rec.ready"; sleep "$FAKE_SLEEP"; fi
exit "\${FAKE_RC:-0}"
`;

/**
 * Remotes (app.git, lib.git with nested.git), a working copy on `dev` with committed, uncommitted, staged and untracked
 * changes, a stash entry, ignored inputs, node_modules, a library mount moved past what main records, an unpushed local
 * main commit, and a newer origin/main pushed from elsewhere (the working copy's origin/main is stale).
 */
function makeScenario({ fakeChild = true, engine = 'sqlite', oldChild = '' } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'dfm-')));
  const env = makeEnv(base);
  const R = path.join(base, 'remotes');
  mkdirSync(R);
  const seed = (name, files, subs = []) => {
    const d = path.join(base, `seed-${name}`);
    git(base, ['init', '-q', d], env);
    for (const [f, c] of Object.entries(files)) write(path.join(d, f), c);
    for (const [p, url] of subs) git(d, ['submodule', 'add', '-q', url, p], env);
    git(d, ['add', '-A'], env); git(d, ['commit', '-qm', `${name} 1`], env);
    git(base, ['clone', '-q', '--bare', d, path.join(R, `${name}.git`)], env);
    git(d, ['remote', 'add', 'origin', path.join(R, `${name}.git`)], env);
    git(d, ['fetch', '-q', 'origin'], env);
    git(d, ['branch', '-q', '--set-upstream-to=origin/main'], env);
    return d;
  };
  seed('nested', { 'nested.txt': 'nested v1\n' });
  const libSeed = seed('lib', { 'lib.txt': 'lib v1\n' }, [['nested', path.join(R, 'nested.git')]]);
  const L1 = git(libSeed, ['rev-parse', 'HEAD'], env);

  const app = path.join(base, 'seed-app');
  git(base, ['init', '-q', app], env);
  write(path.join(app, '.gitignore'), 'node_modules\ndist\n.env*\n!.env.example\n/backups/\nmodules_shared\n*.tgz\nkeys/\ncerts/\n');
  write(path.join(app, 'back/src/main.ts'), 'export const where = "main";\n');
  write(path.join(app, 'back/package.json'), '{"name":"back"}\n');
  write(path.join(app, 'back/package-lock.json'), '{"lockfileVersion":3,"v":"main"}\n');
  write(path.join(app, 'back/.env.example'), 'EXAMPLE=main\n');
  write(path.join(app, 'front/src/app.ts'), 'export const app = "main";\n');
  write(path.join(app, 'front/package.json'), '{"name":"front"}\n');
  write(path.join(app, 'front/package-lock.json'), '{"lockfileVersion":3,"v":"same"}\n');
  write(path.join(app, 'front/nginx.conf'), 'listen ${NODE_PORT};\n');
  write(path.join(app, 'record-hook.sh'), '#!/usr/bin/env bash\n{ echo "HOOK_PWD=$(pwd -P)"; echo "HOOK_MAIN_TS=$(cat "$1/src/main.ts")"; echo "HOOK_FILES=$(cd "$1/src" && ls | tr "\\n" " ")"; } >> "$STUB_LOG"\n', 0o755);
  mkdirSync(path.join(app, 'scripts'));
  if (fakeChild) {
    // main's deploy-full.sh = the recorder; every other entry links to the template (lib/ for the parent is the wc's)
    write(path.join(app, 'scripts/deploy-full.sh'), FAKE_DEPLOY, 0o755);
  } else {
    for (const e of readdirSync(SCRIPTS_DIR)) {
      if (e === 'update_common.sh' || e === 'migrate-db.sh') continue;
      if (oldChild && e === 'deploy-full.sh') { write(path.join(app, 'scripts', e), oldChild, 0o755); continue; }
      symlinkSync(path.join(SCRIPTS_DIR, e), path.join(app, 'scripts', e));
    }
  }
  git(app, ['add', '-A'], env);
  git(app, ['submodule', 'add', '-q', path.join(R, 'lib.git'), 'back/.libs/vx-lib'], env);
  git(app, ['submodule', 'update', '--init', '--recursive', '-q'], env);
  git(app, ['commit', '-qm', 'app main 1'], env);
  git(base, ['clone', '-q', '--bare', app, path.join(R, 'app.git')], env);

  // library main moves on (L2): main does NOT record it
  write(path.join(libSeed, 'lib.txt'), 'lib v2 (not recorded by main)\n');
  git(libSeed, ['commit', '-qam', 'lib 2'], env); git(libSeed, ['push', '-q', 'origin', 'HEAD:main'], env);
  const L2 = git(libSeed, ['rev-parse', 'HEAD'], env);

  // the working copy
  const wc = path.join(base, 'wc');
  git(base, ['clone', '-q', '--recurse-submodules', path.join(R, 'app.git'), wc], env);
  // dev: committed change + new file, the parent script = the template's (wc's scripts link to the real one)
  git(wc, ['checkout', '-q', '-b', 'dev'], env);
  if (fakeChild || oldChild) {
    rmSync(path.join(wc, 'scripts/deploy-full.sh'));
    symlinkSync(path.join(SCRIPTS_DIR, 'deploy-full.sh'), path.join(wc, 'scripts/deploy-full.sh'));
    if (fakeChild) for (const e of ['lib']) symlinkSync(path.join(SCRIPTS_DIR, e), path.join(wc, 'scripts', e));
  }
  write(path.join(wc, 'back/src/main.ts'), 'export const where = "dev";\n');
  write(path.join(wc, 'back/src/devonly.ts'), 'dev only\n');
  write(path.join(wc, 'back/package-lock.json'), '{"lockfileVersion":3,"v":"dev"}\n');
  git(wc, ['add', '-A'], env); git(wc, ['commit', '-qm', 'dev work'], env);
  // a stash entry that must survive
  write(path.join(wc, 'front/src/app.ts'), 'export const app = "stashed";\n');
  git(wc, ['stash', 'push', '-q', '-m', 'user stash'], env);
  // uncommitted + staged + untracked (the agent's new files)
  write(path.join(wc, 'front/src/app.ts'), 'export const app = "uncommitted edit";\n');
  write(path.join(wc, 'back/src/staged.ts'), 'staged\n');
  git(wc, ['add', 'back/src/staged.ts'], env);
  write(path.join(wc, 'back/src/agent-new.ts'), 'import { nope } from "./missing";\n');
  write(path.join(wc, 'front/src/agent-new.tsx'), 'broken(\n');
  // library mount moved to L2 (as update_common.sh would)
  git(path.join(wc, 'back/.libs/vx-lib'), ['checkout', '-q', L2], env);
  // ignored inputs
  const backEnv = `PROJECT_NAME=testapp
DEPLOY_FROM_MAIN=true
REMOTE_USER=deploy
REMOTE_SSH_PORT=22
REMOTE_CONTEXT_NAME=testctx
BACK_REMOTE_APP_DIR=/srv/testapp/back
FRONT_REMOTE_APP_DIR=/srv/testapp/front
BACK_HOSTS=10.0.0.1
FRONT_HOSTS=10.0.0.2
NODE_PORT=9741
DB_ENGINE=${engine}
DB_PATH=data/testapp.db
DB_SSLROOTCERT=certs/ca.crt
SSH_KEY_FILE=keys/deploy.pem
COMPOSE_FILE_NAME=scripts/docker-compose-cloud.yml
BACK_BUILD_HOOK=./record-hook.sh
SECRET_TOKEN=s3cr3t
`;
  write(path.join(wc, 'back/.env'), backEnv);
  write(path.join(wc, 'back/.env.preprod'), backEnv.replace('PROJECT_NAME=testapp', 'PROJECT_NAME=preprodapp'));
  write(path.join(wc, 'front/.env'), 'VITE_PORT=3900\n');
  write(path.join(wc, 'front/.env.production'), 'VITE_MODE_FILE=1\n');
  write(path.join(wc, 'back/certs/ca.crt'), 'CERT\n');
  write(path.join(wc, 'keys/deploy.pem'), 'KEY\n', 0o600);
  write(path.join(wc, 'back/local-pkg.tgz'), 'TGZ\n');
  // node_modules: front lock = main's lock (shadow expected); back lock differs (install expected)
  for (const s of ['front', 'back']) {
    write(path.join(wc, s, 'node_modules/pkg/index.js'), `module.exports = "${s} pkg";\n`);
    write(path.join(wc, s, 'node_modules/@scope/x/index.js'), 'x\n');
    write(path.join(wc, s, 'node_modules/.bin/tool'), '#!/bin/sh\necho tool\n', 0o755);
    write(path.join(wc, s, 'node_modules/.tmp/wc.tsbuildinfo'), 'WC CACHE\n');
    write(path.join(wc, s, 'node_modules/.package-lock.json'), '{}\n');
    const later = Date.now() / 1000 + 5;
    utimesSync(path.join(wc, s, 'node_modules/.package-lock.json'), later, later);
  }
  // unpushed local main commit (must NOT be deployed) and a newer origin/main pushed from elsewhere (must be deployed)
  git(wc, ['branch', '-q', '-f', 'main', 'origin/main'], env);
  const other = path.join(base, 'other');
  git(base, ['clone', '-q', path.join(R, 'app.git'), other], env);
  write(path.join(other, 'back/src/main.ts'), 'export const where = "main v2";\n');
  git(other, ['commit', '-qam', 'main v2 published'], env); git(other, ['push', '-q', 'origin', 'main'], env);
  const MAIN2 = git(other, ['rev-parse', 'HEAD'], env);
  // local main: one commit not on origin/main
  const tree = git(wc, ['rev-parse', 'origin/main^{tree}'], env);
  const unpushed = git(wc, ['commit-tree', tree, '-p', 'refs/heads/main', '-m', 'unpushed local main'], env);
  git(wc, ['update-ref', 'refs/heads/main', unpushed], env);

  return { base, env, wc, R, L1, L2, MAIN2, record: path.join(base, 'record') };
}

/** Everything observable in the working copy: files (content, mode, mtime), links, git state. */
function snapshot(wc, env, { skip = ['backups'] } = {}) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(wc, rel);
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === '.git' || skip.includes(r)) continue;
      const st = lstatSync(path.join(wc, r));
      if (st.isSymbolicLink()) out.push(`L ${r} -> ${readlinkSync(path.join(wc, r))}`);
      else if (st.isDirectory()) { out.push(`D ${r} ${st.mode} ${st.mtimeMs}`); walk(r); }
      else out.push(`F ${r} ${st.mode} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(path.join(wc, r))).digest('hex')}`);
    }
  };
  walk('');
  const g = (args, cwd = wc) => git(cwd, args, env, { allowFail: true });
  out.push(`HEAD ${g(['symbolic-ref', 'HEAD'])} ${g(['rev-parse', 'HEAD'])}`);
  out.push(`REFS ${g(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/stash', 'refs/tags'])}`);
  out.push(`STASH ${g(['stash', 'list'])}`);
  out.push(`STASH_CONTENT ${g(['stash', 'show', '-p', 'stash@{0}'])}`);
  out.push(`STATUS ${g(['status', '--porcelain=v1', '-uall'])}`);
  out.push(`INDEX ${g(['ls-files', '-s'])}`);
  out.push(`SUB ${g(['rev-parse', 'HEAD'], path.join(wc, 'back/.libs/vx-lib'))}`);
  out.push(`WORKTREES ${g(['worktree', 'list', '--porcelain'])}`);
  const common = path.resolve(wc, g(['rev-parse', '--git-common-dir']));
  out.push(`CONFIG ${readFileSync(path.join(common, 'config'), 'utf8')}`);
  out.push(`GITDIRS ${readdirSync(common).sort().join(',')}`);
  return out;
}

function runDeploy(s, args = [], extraEnv = {}) {
  const r = spawnSync('bash', [path.join(s.wc, 'scripts/deploy-full.sh'), ...args], {
    cwd: s.wc, env: { ...s.env, FAKE_RECORD: s.record, ...extraEnv }, encoding: 'utf8', timeout: 300000,
  });
  return { status: r.status, signal: r.signal, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') };
}

const tmpEntries = (s) => readdirSync(s.env.TMPDIR).filter((e) => e.startsWith('testapp-main.'));
const kv = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_a-z]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const diff = (a, b) => { const sa = new Set(a); const sb = new Set(b); return { gone: a.filter((x) => !sb.has(x)), added: b.filter((x) => !sa.has(x)) }; };

dfmTest('fake child: the tree is exactly the NEW origin/main + recorded submodules; inputs staged; working copy byte-identical; tree removed', () => {
  const s = makeScenario();
  const before = snapshot(s.wc, s.env);
  const r = runDeploy(s, ['--target=back', '--migrate']);
  const after = snapshot(s.wc, s.env);
  if (process.env.DFM_DEBUG) process.stdout.write(`\n----- deploy output -----\n${r.out}\n-----\n`);
  try {
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(diff(before, after), { gone: [], added: [] }, 'working copy unchanged');
    assert.equal(git(s.wc, ['rev-parse', 'refs/remotes/origin/main'], s.env), s.MAIN2, 'only origin/main moved (fetch)');
    assert.deepEqual(tmpEntries(s), [], 'temporary tree removed');
    const rec = kv(s.record);
    const short = s.MAIN2.slice(0, 7);
    assert.equal(rec.DEPLOY_FROM_MAIN, '0');
    assert.equal(rec.DEPLOY_LIBS_SYNCED, '1');
    assert.equal(rec.DEPLOY_REVISION, short, 'revision = new origin/main');
    assert.equal(rec.BACK_ENV_FILE, './back/.env');
    assert.equal(rec.FRONT_ENV_FILE, './front/.env');
    assert.equal(rec.ARGS, '--target=back --migrate');
    assert.match(rec.SCRIPT, /\/scripts\/deploy-full\.sh$/);
    assert.ok(rec.PWD.startsWith(`${s.env.TMPDIR}/testapp-main.`), rec.PWD);
    assert.match(rec.DEPLOY_TIMINGS, /main: fetch origin\/main=\d+;main: clean clone \+ submodules=\d+;main: local inputs \+ node_modules=\d+/);
    assert.equal(rec.NPM_front, 'skip', 'front: same lock -> shadow node_modules + stamp');
    assert.equal(rec.NPM_back, 'install', 'back: lock differs -> install in the tree');
    const status = readFileSync(s.record, 'utf8').split('STATUS<<\n')[1].split('>>')[0];
    assert.equal(status.trim(), '?? backups', 'only the backups link is untracked in the tree (sqlite)');
    const t = `${s.record}.tree`;
    assert.equal(readFileSync(path.join(t, 'back/src/main.ts'), 'utf8'), 'export const where = "main v2";\n', 'main v2 content');
    assert.equal(readFileSync(path.join(t, 'front/src/app.ts'), 'utf8'), 'export const app = "main";\n');
    for (const f of ['back/src/devonly.ts', 'back/src/staged.ts', 'back/src/agent-new.ts', 'front/src/agent-new.tsx']) {
      assert.ok(!existsSync(path.join(t, f)), `${f} must not reach the tree`);
    }
    assert.equal(readFileSync(path.join(t, 'back/package-lock.json'), 'utf8'), '{"lockfileVersion":3,"v":"main"}\n');
    assert.equal(readFileSync(path.join(t, 'back/.libs/vx-lib/lib.txt'), 'utf8'), 'lib v1\n', 'library at the commit main records (L1), not L2');
    assert.equal(readFileSync(path.join(t, 'back/.libs/vx-lib/nested/nested.txt'), 'utf8'), 'nested v1\n', 'nested submodule');
    const subs = readFileSync(`${s.record}.subs`, 'utf8');
    assert.match(subs, new RegExp(`^ ${s.L1} back/\\.libs/vx-lib`, 'm'));
    assert.match(subs, /^ [0-9a-f]{40} back\/\.libs\/vx-lib\/nested/m);
    // inputs
    const backEnvT = readFileSync(path.join(t, 'back/.env'), 'utf8');
    assert.doesNotMatch(backEnvT, /DEPLOY_FROM_MAIN/);
    assert.match(backEnvT, /SECRET_TOKEN=s3cr3t/);
    assert.equal(readFileSync(path.join(s.wc, 'back/.env'), 'utf8').replace('DEPLOY_FROM_MAIN=true\n', ''), backEnvT, 'only that line removed');
    assert.equal((lstatSync(path.join(t, 'back/.env')).mode & 0o777).toString(8), '600');
    assert.equal(readFileSync(path.join(t, 'back/.env.example'), 'utf8'), 'EXAMPLE=main\n', 'tracked file of main kept');
    for (const f of ['back/.env.preprod', 'front/.env', 'front/.env.production', 'back/certs/ca.crt', 'keys/deploy.pem', 'back/local-pkg.tgz']) {
      assert.ok(existsSync(path.join(t, f)), `${f} staged`);
    }
    // node_modules: front = real dir of links + stamp, caches not linked; back = none
    const fnm = path.join(t, 'front/node_modules');
    assert.ok(lstatSync(fnm).isDirectory() && !lstatSync(fnm).isSymbolicLink());
    assert.equal(readlinkSync(path.join(fnm, 'pkg')), path.join(s.wc, 'front/node_modules/pkg'));
    assert.ok(lstatSync(path.join(fnm, '.bin')).isSymbolicLink() && lstatSync(path.join(fnm, '@scope')).isSymbolicLink());
    assert.ok(!existsSync(path.join(fnm, '.tmp')), 'build caches are not linked');
    assert.ok(existsSync(path.join(fnm, '.vx-deploy-install')));
    assert.ok(!existsSync(path.join(t, 'back/node_modules')));
    assert.equal(readlinkSync(path.join(t, 'backups')), path.join(s.wc, 'backups'), 'tree ./backups -> project backups');
    assert.deepEqual(readdirSync(path.join(s.wc, 'backups')), [], 'the only new entry of the working copy: its (empty) backups/ folder');
    // logs
    assert.match(r.out, /the working copy \(.*, dev\) is not touched/);
    assert.match(r.out, new RegExp(`Deploying origin/main ${short} — main v2 published`));
    assert.match(r.out, /Local branch main has 1 commit\(s\) that origin\/main does not have: NOT deployed/);
    assert.match(r.out, /main records another deploy-full\.sh than the one launched/);
    assert.match(r.out, /front: same package\.json and package-lock\.json as the working copy/);
    assert.match(r.out, /back: npm install into the clean tree \(main's package-lock\.json differs/);
    assert.match(r.out, /Copied from the working copy \(not in git\): .*back\/\.env \(without DEPLOY_FROM_MAIN\)/);
    assert.doesNotMatch(r.out, /s3cr3t/, 'no secret printed');
    assert.match(r.out, new RegExp(`origin/main ${short} deployed — the working copy \\(dev\\) was not touched`));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('fake child: its exit code (3 = rolled back) is propagated, tree removed, working copy unchanged', () => {
  const s = makeScenario();
  const before = snapshot(s.wc, s.env);
  const r = runDeploy(s, [], { FAKE_RC: '3' });
  try {
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /ended with exit 3 — the working copy \(dev\) was not touched/);
    assert.deepEqual(tmpEntries(s), []);
    assert.deepEqual(diff(before, snapshot(s.wc, s.env)), { gone: [], added: [] });
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('preparation failure (origin unreachable): exit 1, nothing deployed, no tree, working copy unchanged', () => {
  const s = makeScenario();
  git(s.wc, ['remote', 'set-url', 'origin', path.join(s.R, 'missing.git')], s.env);
  const before = snapshot(s.wc, s.env);
  const r = runDeploy(s);
  try {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /could not fetch origin\/main — nothing was deployed/);
    assert.ok(!existsSync(s.record), 'child never ran');
    assert.deepEqual(tmpEntries(s), []);
    assert.deepEqual(diff(before, snapshot(s.wc, s.env)), { gone: [], added: [] });
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

/** Starts the deploy in its own process group, waits for the child to be running, sends <sig> to the group or the parent. */
function interrupted(s, sig, target) {
  return new Promise((resolve) => {
    const p = spawn('bash', [path.join(s.wc, 'scripts/deploy-full.sh'), '--target=back'], {
      cwd: s.wc, env: { ...s.env, FAKE_RECORD: s.record, FAKE_SLEEP: '4' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    let treeSeen = null;
    let killedAt = 0;
    const poll = setInterval(() => {
      if (existsSync(`${s.record}.ready`)) {
        clearInterval(poll);
        treeSeen = tmpEntries(s);
        killedAt = Date.now();
        if (target === 'group') process.kill(-p.pid, sig); else process.kill(p.pid, sig);
      }
    }, 50);
    p.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out: out.replace(/\x1b\[[0-9;]*m/g, ''), treeSeen, ms: Date.now() - killedAt }); });
  });
}

dfmTest('Ctrl-C (SIGINT to the process group) while the deploy runs: exit 130, tree removed, working copy unchanged', async () => {
  const s = makeScenario();
  const before = snapshot(s.wc, s.env);
  const r = await interrupted(s, 'SIGINT', 'group');
  try {
    assert.equal(r.treeSeen.length, 1, 'the tree existed while the deploy ran');
    assert.equal(r.code, 130, r.out);
    assert.deepEqual(tmpEntries(s), [], 'tree removed');
    assert.deepEqual(diff(before, snapshot(s.wc, s.env)), { gone: [], added: [] });
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('SIGTERM to the parent alone: the running deploy is NOT cut, the tree is removed once it ended (exit 143)', async () => {
  const s = makeScenario();
  const r = await interrupted(s, 'SIGTERM', 'parent');
  try {
    assert.equal(r.code, 143, r.out);
    assert.ok(r.ms >= 3000, `the parent waited for the child to end (${r.ms} ms after the signal)`);
    assert.deepEqual(tmpEntries(s), []);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('SIGHUP to the group (tmux kill-session): exit 129, tree removed', async () => {
  const s = makeScenario();
  const r = await interrupted(s, 'SIGHUP', 'group');
  try {
    assert.equal(r.code, 129, r.out);
    assert.deepEqual(tmpEntries(s), []);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('KEEP_BUILD_CONTEXT=1 keeps the tree; DEPLOY_NPM_INSTALL=always never reuses node_modules', () => {
  const s = makeScenario();
  const r = runDeploy(s, [], { KEEP_BUILD_CONTEXT: '1', DEPLOY_NPM_INSTALL: 'always' });
  try {
    assert.equal(r.status, 0, r.out);
    assert.equal(tmpEntries(s).length, 1);
    assert.match(r.out, /KEEP_BUILD_CONTEXT=1: the clean tree of main stays at/);
    assert.equal(kv(s.record).NPM_front, 'install');
    assert.match(r.out, /front: npm install into the clean tree \(DEPLOY_NPM_INSTALL=always\)/);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('front node_modules older than its lock (pulled, not installed): no reuse', () => {
  const s = makeScenario();
  const old = Date.now() / 1000 - 3600;
  utimesSync(path.join(s.wc, 'front/node_modules/.package-lock.json'), old, old);
  const r = runDeploy(s);
  try {
    assert.equal(r.status, 0, r.out);
    assert.equal(kv(s.record).NPM_front, 'install');
    assert.match(r.out, /front: npm install into the clean tree \(the working copy's package-lock\.json changed since its last install\)/);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('rollback mode ignores DEPLOY_FROM_MAIN (no fetch, no clone)', () => {
  const s = makeScenario();
  const r = runDeploy(s, ['--rollback', '--target=back']);
  try {
    assert.doesNotMatch(r.out, /DEPLOY_FROM_MAIN=true: deploying/);
    assert.ok(!existsSync(s.record));
    assert.deepEqual(tmpEntries(s), []);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('END TO END: the real template deploy-full.sh of main deploys from the tree (stub docker/ssh/npm), working copy unchanged', () => {
  const s = makeScenario({ fakeChild: false });
  writeFileSync(path.join(s.env.STUB_STATE, 'img_testapp_back_latest'), 'v1\n'); // running v1 + its SQLite volume
  writeFileSync(path.join(s.env.STUB_STATE, 'vol_testapp-back-10-0-0-1_sqlite_data'), '');
  const before = snapshot(s.wc, s.env);
  const r = runDeploy(s, []);
  const after = snapshot(s.wc, s.env);
  if (process.env.DFM_DEBUG) process.stdout.write(`\n----- deploy output -----\n${r.out}\n-----\n`);
  try {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /==> Deployment completed/);
    const short = s.MAIN2.slice(0, 7);
    const log = readFileSync(s.env.STUB_LOG, 'utf8');
    assert.deepEqual(diff(before, after), { gone: [], added: [] }, 'working copy unchanged (backups/ apart)');
    assert.deepEqual(tmpEntries(s), [], 'tree removed');
    assert.deepEqual(readdirSync(s.env.TMPDIR).filter((e) => e.includes('build-context')), [], 'build context removed');
    // the build ran in the tree, with main's sources only
    assert.match(log, /HOOK_MAIN_TS=export const where = "main v2";/);
    assert.match(log, /HOOK_FILES=main\.ts \n/);
    assert.match(log, /HOOK_PWD=.*\/testapp-main\.[A-Za-z0-9]+$/m);
    const npm = log.split('\n').filter((l) => l.startsWith('npm '));
    assert.ok(npm.every((l) => /@ .*\/testapp-main\.[A-Za-z0-9]+\/(back|front)$/.test(l)), npm.join('\n'));
    assert.equal(npm.filter((l) => l.startsWith('npm install') && l.endsWith('/back')).length, 1, 'back installed (lock differs)');
    assert.equal(npm.filter((l) => l.startsWith('npm install') && l.endsWith('/front')).length, 0, 'front reused the working copy node_modules');
    assert.equal(npm.filter((l) => l.startsWith('npm run build')).length, 2);
    // revision + env uploaded
    assert.match(log, new RegExp(`ENV_SNAPSHOT: DEPLOY_REVISION=${short}`));
    const uploaded = readFileSync(path.join(s.env.STUB_STATE, 'uploaded_.env.remote'), 'utf8');
    assert.doesNotMatch(uploaded, /DEPLOY_FROM_MAIN/);
    assert.match(uploaded, new RegExp(`DEPLOY_REVISION=${short}`));
    // persistent output landed in the project
    const copies = readdirSync(path.join(s.wc, 'backups/deploy-prod'));
    assert.equal(copies.length, 1, copies.join(','));
    assert.match(copies[0], new RegExp(`^testapp-pre-${short}-\\d{8}T\\d{6}Z\\.db\\.tar\\.gz$`));
    assert.match(r.out, /\[TIME\] Summary[\s\S]*main: clean clone \+ submodules/);
    assert.match(r.out, new RegExp(`origin/main ${short} deployed — the working copy \\(dev\\) was not touched`));
    // the wc's own built artefacts never appeared
    assert.ok(!existsSync(path.join(s.wc, 'back/dist')) && !existsSync(path.join(s.wc, 'back_build')) && !existsSync(path.join(s.wc, 'front_build')));
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('OFF: DEPLOY_FROM_MAIN unset deploys the working copy as before (no fetch, no clone)', () => {
  const s = makeScenario({ fakeChild: false });
  const envFile = path.join(s.wc, 'back/.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace('DEPLOY_FROM_MAIN=true\n', ''));
  const r = runDeploy(s, ['--target=back']);
  try {
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /DEPLOY_FROM_MAIN/);
    assert.deepEqual(tmpEntries(s), []);
    const log = readFileSync(s.env.STUB_LOG, 'utf8');
    assert.match(log, /HOOK_MAIN_TS=export const where = "dev";/, 'the working copy is what gets built');
    assert.match(log, /HOOK_FILES=.*agent-new\.ts/, 'including its untracked files, as before');
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

dfmTest('launched from a linked worktree of the project: clones from the common git dir, deploys origin/main', () => {
  const s = makeScenario();
  const wt = path.join(s.base, 'wt');
  git(s.wc, ['worktree', 'add', '-q', '-b', 'feature', wt, 'dev'], s.env);
  git(wt, ['submodule', 'update', '--init', '--recursive', '-q'], s.env);
  for (const f of ['back/.env', 'front/.env']) write(path.join(wt, f), readFileSync(path.join(s.wc, f), 'utf8'));
  const before = snapshot(wt, s.env);
  const r = spawnSync('bash', [path.join(wt, 'scripts/deploy-full.sh'), '--target=back'], {
    cwd: wt, env: { ...s.env, FAKE_RECORD: s.record }, encoding: 'utf8', timeout: 300000,
  });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(kv(s.record).DEPLOY_REVISION, s.MAIN2.slice(0, 7));
    assert.equal(readFileSync(`${s.record}.tree/back/src/main.ts`, 'utf8'), 'export const where = "main v2";\n');
    assert.deepEqual(diff(before, snapshot(wt, s.env)), { gone: [], added: [] });
    assert.deepEqual(tmpEntries(s), []);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});

const oldScript = SKIP ? null : spawnSync('git', ['-C', SCRIPTS_DIR, 'show', `${OLD_SCRIPT_COMMIT}:./deploy-full.sh`], { encoding: 'utf8' });
test('main records the OLD deploy-full.sh (vx-public 3e211b6, stash/checkout block): it runs inert, no branch switch, deploys main', {
  skip: SKIP || (oldScript.status !== 0 && `vx-public commit ${OLD_SCRIPT_COMMIT.slice(0, 7)} not available (not a full git checkout)`),
}, () => {
  const s = makeScenario({ fakeChild: false, oldChild: oldScript.stdout });
  writeFileSync(path.join(s.env.STUB_STATE, 'img_testapp_back_latest'), 'v1\n');
  writeFileSync(path.join(s.env.STUB_STATE, 'vol_testapp-back-10-0-0-1_sqlite_data'), '');
  const before = snapshot(s.wc, s.env);
  const r = runDeploy(s, ['--target=back']);
  try {
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /main records another deploy-full\.sh than the one launched/);
    assert.doesNotMatch(r.out, /stashing local changes|switching from/);
    assert.match(r.out, /==> Deployment completed \(back only\)/);
    const log = readFileSync(s.env.STUB_LOG, 'utf8');
    // (fixture: this old script is a plain file, its TEMPLATE_ROOT has no Dockerfile.prebuilt -> remote build, no hook)
    assert.match(log, new RegExp(`ENV_SNAPSHOT: DEPLOY_REVISION=${s.MAIN2.slice(0, 7)}`));
    assert.doesNotMatch(log, /ENV_SNAPSHOT: DEPLOY_FROM_MAIN/);
    assert.match(log, /npm install --no-audit --no-fund @ .*\/testapp-main\.[A-Za-z0-9]+\/back\n/);
    assert.deepEqual(diff(before, snapshot(s.wc, s.env)), { gone: [], added: [] });
    assert.equal(git(s.wc, ['symbolic-ref', '--short', 'HEAD'], s.env), 'dev');
    assert.deepEqual(tmpEntries(s), []);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});
