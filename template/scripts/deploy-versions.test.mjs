/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// End-to-end tests of run.sh / deploy-full.sh / lib/deploy-versions.sh against STUB executables (docker, ssh, scp, rsync,
// git, npm...) put first on PATH: nothing ever reaches a real host. Every stub appends its argv to $STUB_LOG; image tags are
// files in $STUB_STATE (content = fake image id) so retag/swap logic can be checked; env vars drive the outcomes
// (STUB_BACK_HEALTH=bad, STUB_ROLLBACK_UNHEALTHY=1, STUB_FRONT_FAIL=1, STUB_RUN_FAIL=1, STUB_WORKER_FAIL=new,
// STUB_PG=absent, STUB_PGDUMP_FAIL=1, STUB_RECENT_DUMP=<path>, STUB_PS_LINES=<docker ps -a lines>, STUB_GIT_TOP=<dir>...).
//
// Run: node --test scripts/deploy-versions.test.mjs   (needs bash and python3)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACK_PROJECT = 'testapp-back-10-0-0-1'; // compose project name of the back host 10.0.0.1
const FRONT_PROJECT = 'testapp-front-10-0-0-2';

const STUBS = {
  docker: `#!/usr/bin/env bash
line="docker $*"; line="$(printf '%s' "$line" | tr '\\n' ' ')"; echo "\${line% }" >> "$STUB_LOG"
S="$STUB_STATE"
key() { printf '%s' "$1" | tr '/:' '__'; }
img() { echo "$S/img_$(key "$1")"; }
if [ "\${1:-}" = "--context" ]; then shift 2; fi
cmd="\${1:-}"; if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  context) if [ "\${1:-}" = inspect ]; then exit 1; fi ;;
  image) if [ "\${1:-}" = inspect ]; then [ -f "$(img "$2")" ]; exit $?; fi ;;
  tag) [ -f "$(img "$1")" ] || exit 1; cp "$(img "$1")" "$(img "$2")" ;;
  rmi) rm -f "$(img "$1")" ;;
  build) while [ $# -gt 0 ]; do if [ "$1" = --tag ]; then echo base > "$(img "$2")"; fi; shift; done; cat > /dev/null ;;
  inspect)
    case "$*" in
      *_back_lb*) [ "\${STUB_LB:-1}" != 0 ]; exit $? ;;
      *_postgres*) [ "\${STUB_PG:-running}" = running ] || exit 1; case "$*" in *State.Running*) echo true ;; esac; exit 0 ;;
    esac
    exit 1 ;;
  ps) case "$*" in *"-q -f"*) echo cid123 ;; *"--format"*) printf '%b' "\${STUB_PS_LINES:-}" ;; esac ;;
  volume) if [ "\${1:-}" = inspect ]; then [ -f "$S/vol_$2" ]; exit $?; fi ;;
  run)
    if [ -n "\${STUB_RUN_FAIL:-}" ]; then exit 1; fi
    case "$*" in
      *RESTORE_OK*) echo RESTORE_OK ;;
      *BACKUP_OK*) echo BACKUP_OK ;;
      *"tar -cf"*)
        # SQLite local copy: the last argument is the gzip level ("" = plain tar); STUB_TAR_CUT = a stream cut short
        last="\${!#}"
        if [ -n "$last" ]; then
          printf TARDATA > "$STUB_STATE/testapp.db"
          if [ -n "\${STUB_TAR_CUT:-}" ]; then tar -cf - -C "$STUB_STATE" testapp.db | gzip -"$last" -c | head -c 12
          else tar -cf - -C "$STUB_STATE" testapp.db | gzip -"$last" -c; fi
        else echo TARDATA; fi ;;
    esac ;;
  exec) case "$*" in *pg_dump*) echo "-- pg dump" ;; esac ;;
  compose)
    proj=""; dir=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --project-directory) dir="$2"; shift 2 ;;
        --project-name) proj="$2"; shift 2 ;;
        --profile) shift 2 ;;
        *) break ;;
      esac
    done
    sub="$1"; shift
    echo "COMPOSE_ENV[$sub]: BACK_NODE_ROLE=\${BACK_NODE_ROLE:-}" >> "$STUB_LOG"
    case "$sub" in
      build)
        case "$*" in *back*) echo new > "$(img "\${PROJECT_NAME}_back:latest")" ;; esac
        case "$*" in *front*) echo new > "$(img "$proj-front:latest")" ;; esac ;;
      up)
        if [ -f "$dir/back/.env" ]; then sed 's/^/ENV_SNAPSHOT: /' "$dir/back/.env" >> "$STUB_LOG"; fi
        if [ -n "\${STUB_UP_FAIL:-}" ]; then exit 1; fi
        case "$*" in *back-worker*)
          # STUB_WORKER_FAIL=new: back-worker only fails to start with the NEW image (the rollback one starts)
          if [ "\${STUB_WORKER_FAIL:-}" = 1 ]; then exit 1; fi
          if [ "\${STUB_WORKER_FAIL:-}" = new ] && [ "$(cat "$(img "\${PROJECT_NAME}_back:latest")" 2>/dev/null)" = new ]; then exit 1; fi ;;
        esac ;;
      ps)
        last="\${!#}"
        if [ "$last" = front ]; then
          content="$(cat "$(img "$proj-front:latest")" 2>/dev/null || true)"
          if [ "$content" = new ] && [ -n "\${STUB_FRONT_FAIL:-}" ]; then echo "exited "; else echo "running "; fi
        elif [ "$last" = back ]; then
          content="$(cat "$(img "\${PROJECT_NAME}_back:latest")" 2>/dev/null || true)"
          if [ "$content" = new ] && [ "\${STUB_BACK_HEALTH:-}" = bad ]; then echo unhealthy
          elif [ "$content" != new ] && [ "\${STUB_ROLLBACK_UNHEALTHY:-}" = 1 ]; then echo unhealthy
          else echo healthy; fi
        fi ;;
    esac ;;
esac
exit 0
`,
  ssh: `#!/usr/bin/env bash
echo "ssh $*" >> "$STUB_LOG"
cmd="\${!#}"
case "$cmd" in
  "echo SSH_OK") echo SSH_OK ;;
  'printf %s "$HOME"') printf %s /home/deploy ;;
  *"cat '"*current.json*) if [ -n "\${STUB_CURRENT_JSON:-}" ]; then cat "$STUB_CURRENT_JSON"; fi ;;
  *"cat > current.json"*) echo "STATE_JSON: $(cat)" >> "$STUB_LOG" ;;
  *pg_dump*) if [ -n "\${STUB_PGDUMP_FAIL:-}" ]; then exit 1; fi; printf 'COMPRESSION=zstd:9\nSIZE=3145728\n' ;;
  *"-mmin"*) if [ -n "\${STUB_RECENT_DUMP:-}" ]; then echo "$STUB_RECENT_DUMP"; fi ;;
esac
exit 0
`,
  scp: `#!/usr/bin/env bash
echo "scp $*" >> "$STUB_LOG"
n=$#; dst="\${!n}"; src="\${@:$((n-1)):1}"
case "$src" in
  *:*) if [ -n "\${STUB_REMOTE_ENV:-}" ]; then cp "$STUB_REMOTE_ENV" "$dst"; else printf 'FROM_REMOTE=1\\nSERVER_IP=prev\\n' > "$dst"; fi ;;
  *) cp "$src" "$STUB_STATE/uploaded_$(basename "$src")" ;;
esac
exit 0
`,
  rsync: `#!/usr/bin/env bash
echo "rsync $*" >> "$STUB_LOG"
args=(); for a in "$@"; do case "$a" in -*) ;; *) args+=("$a") ;; esac; done
n=\${#args[@]}; src="\${args[$((n-2))]}"; dst="\${args[$((n-1))]}"
case "$src" in
  */) mkdir -p "$dst"; cp -R "$src." "$dst" ;;
  *) mkdir -p "$(dirname "$dst")"; cp "$src" "$dst" ;;
esac
exit 0
`,
  git: `#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
case "$*" in
  *show-toplevel*) if [ -n "\${STUB_GIT_TOP:-}" ]; then echo "$STUB_GIT_TOP"; else exit 1; fi ;;
  *--get-regexp*) echo "submodule.back/.libs/vx-public.path back/.libs/vx-public" ;;
  *"rev-parse --short HEAD"*) echo "\${STUB_GIT_REV:-abc1234}" ;;
  *"status --porcelain"*) if [ -n "\${STUB_GIT_DIRTY:-}" ]; then echo " M file"; fi ;;
esac
exit 0
`,
  npm: '#!/usr/bin/env bash\necho "npm $*" >> "$STUB_LOG"\nexit 0\n',
  npx: '#!/usr/bin/env bash\necho "npx $*" >> "$STUB_LOG"\nexit 0\n',
  curl: '#!/usr/bin/env bash\necho "curl $*" >> "$STUB_LOG"\nexit 0\n',
  envsubst: '#!/usr/bin/env bash\ncat\n',
  sleep: '#!/usr/bin/env bash\nexit 0\n',
};

function write(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

/** A throw-away project (symlinked template scripts, stub binaries, stub state) + a runner for run.sh. */
function makeProject({ engine = 'sqlite', extraBackEnv = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dv-'));
  const bin = path.join(root, '.stubs');
  const state = path.join(root, '.stub-state');
  const log = path.join(root, '.stub.log');
  mkdirSync(state, { recursive: true });
  writeFileSync(log, '');
  for (const [name, body] of Object.entries(STUBS)) write(path.join(bin, name), body, 0o755);

  // scripts/: symlink every template entry, except update_common.sh (logging stub: it would commit and push libraries).
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts);
  for (const entry of readdirSync(SCRIPTS_DIR)) {
    if (entry === 'update_common.sh' || entry === 'migrate-db.sh') continue;
    symlinkSync(path.join(SCRIPTS_DIR, entry), path.join(scripts, entry));
  }
  write(path.join(scripts, 'update_common.sh'), '#!/usr/bin/env bash\necho "update_common.sh $*" >> "$STUB_LOG"\n', 0o755);
  write(path.join(scripts, 'migrate-db.sh'), '#!/usr/bin/env bash\necho "migrate-db.sh $*" >> "$STUB_LOG"\n', 0o755);

  const compose = engine === 'postgres' ? 'docker-compose.yml' : 'docker-compose-cloud.yml';
  const backEnv = (name) => `PROJECT_NAME=${name}
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
DB_USER=u
DB_NAME=n
DB_PASSWORD=p
DB_HOST=db.example.com
DB_PORT=5432
SERVER_IP=old
COMPOSE_FILE_NAME=scripts/${compose}
${extraBackEnv}
`;
  write(path.join(root, 'back/.env'), backEnv('testapp'));
  write(path.join(root, 'back/.env.preprod'), backEnv('preprodapp'));
  write(path.join(root, 'back/dist/main.js'), '// built\n');
  write(path.join(root, 'back/package.json'), '{}\n');
  write(path.join(root, 'front/.env'), 'VITE_PORT=3900\n');
  write(path.join(root, 'front/dist/index.html'), '<html></html>\n');
  write(path.join(root, 'front/nginx.conf'), 'listen ${NODE_PORT};\n');
  write(path.join(root, 'front/package.json'), '{}\n');

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    TMPDIR: root,
    STUB_LOG: log,
    STUB_STATE: state,
  };

  return {
    root, log, state,
    run(args, extraEnv = {}, script = 'run.sh') {
      const res = spawnSync('bash', [path.join(scripts, script), ...args], {
        cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000,
      });
      if (process.env.DV_DEBUG) process.stderr.write(`--- ${args.join(' ')} (exit ${res.status})\n${readFileSync(log, 'utf8')}\n`);
      return { status: res.status, out: res.stdout + res.stderr, stdout: res.stdout, stderr: res.stderr };
    },
    logLines: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    seedImage(ref, content) { writeFileSync(path.join(state, `img_${ref.replace(/[/:]/g, '_')}`), `${content}\n`); },
    image(ref) {
      const file = path.join(state, `img_${ref.replace(/[/:]/g, '_')}`);
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    },
    seedVolume(name) { writeFileSync(path.join(state, `vol_${name}`), ''); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const indexOfLine = (lines, re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Project with a running v1 deployed (latest image + sqlite volume), ready for a v2 deploy. */
function deployedProject(opts) {
  const p = makeProject(opts);
  p.seedImage('testapp_back:latest', 'v1');
  p.seedVolume(`${BACK_PROJECT}_sqlite_data`);
  return p;
}

test('run.sh --no-update-common skips update_common.sh and is not forwarded to deploy-full.sh', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^update_common\.sh/), -1);
    assert.ok(indexOfLine(lines, /^docker .*compose .* build /) >= 0, 'deploy-full.sh ran');
    assert.match(strip(r.out), /Skipping shared library sync/);
  } finally { p.cleanup(); }
});

test('run.sh SKIP_UPDATE_COMMON=1 skips the sync, and the default still runs it', () => {
  const p = deployedProject();
  try {
    let r = p.run(['preprod', '--target=back'], { SKIP_UPDATE_COMMON: '1' });
    assert.equal(r.status, 0, r.out);
    assert.equal(indexOfLine(p.logLines(), /^update_common\.sh/), -1);
    r = p.run(['preprod', '--target=back']);
    assert.ok(indexOfLine(p.logLines(), /^update_common\.sh/) >= 0, 'default behaviour unchanged');
  } finally { p.cleanup(); }
});

test('run.sh rollback: usage errors and refusal without a previous image (nothing built, nothing changed)', () => {
  const p = makeProject();
  try {
    assert.equal(p.run(['rollback']).status, 1);
    assert.equal(p.run(['rollback', 'staging']).status, 1);
    assert.equal(p.run(['rollback', 'prod', '--bogus']).status, 1);

    p.seedImage('testapp_back:latest', 'v1'); // running version, but no :previous
    const r = p.run(['rollback', 'prod', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no testapp_back:previous image/);
    assert.match(r.out, /Nothing was changed/);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^update_common\.sh/), -1);
    assert.equal(indexOfLine(lines, /compose .* (build|up) /), -1);
    assert.equal(indexOfLine(lines, /^git .*submodule/), -1);
    assert.equal(indexOfLine(lines, /^npm /), -1);
    assert.equal(indexOfLine(lines, /^rsync /), -1);
    assert.equal(p.image('testapp_back:latest'), 'v1');
  } finally { p.cleanup(); }
});

test('run.sh rollback preprod selects the preprod env files', () => {
  const p = makeProject();
  try {
    const r = p.run(['rollback', 'preprod', '--target=back']);
    assert.equal(r.status, 1);
    assert.match(r.out, /preprodapp_back:previous/);
  } finally { p.cleanup(); }
});

test('deploy: tags the current images as previous BEFORE the build, backs up the database, writes the state', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Tagging current images as previous$/m);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Backing up database$/m);

    const lines = p.logLines();
    const tag = indexOfLine(lines, /^docker .* tag testapp_back:latest testapp_back:previous$/);
    const build = indexOfLine(lines, /^docker .*compose .* build /);
    const backup = indexOfLine(lines, /^docker .* run --rm --entrypoint sh -v .*sqlite_data:\/data/);
    const up = indexOfLine(lines, /^docker .*compose .* up -d /);
    assert.ok(tag >= 0 && build > tag, 'previous tagged before the build');
    assert.ok(backup > build && up > backup, 'backup after the old services stopped, before up');
    assert.ok(indexOfLine(lines, /rm -sf back back-worker/) < backup, 'old back stopped before the backup');
    assert.equal(p.image('testapp_back:previous'), 'v1');
    assert.equal(p.image('testapp_back:latest'), 'new');
    assert.ok(indexOfLine(lines, /^ssh .*cp -p '\/srv\/testapp\/back\/\.env' '\/srv\/testapp\/back\/\.env\.previous'/) >= 0, 'remote .env kept as .env.previous');
    const state = lines.find((l) => l.startsWith('STATE_JSON: '));
    assert.ok(state, 'state written');
    const json = JSON.parse(state.slice('STATE_JSON: '.length));
    assert.equal(json.revision, 'abc1234');
    assert.equal(json.environment, 'prod');
    assert.match(json.dbBackup, /^\/data\/backups\/testapp-pre-abc1234-\d{8}T\d{6}Z\.db$/);
    assert.ok(Date.parse(json.date) > 0);
    assert.ok(indexOfLine(lines, /^ssh .*mv -f current\.json previous\.json/) >= 0, 'current moved to previous');
    // DEPLOY_REVISION reaches the container env and the remote .env; SERVER_IP is patched portably.
    assert.ok(lines.includes('ENV_SNAPSHOT: DEPLOY_REVISION=abc1234'));
    assert.ok(lines.includes('ENV_SNAPSHOT: SERVER_IP=10.0.0.1'));
    assert.match(readFileSync(path.join(p.state, 'uploaded_.env.remote'), 'utf8'), /^DEPLOY_REVISION=abc1234$/m);
    assert.equal(readdirSync(p.root).filter((f) => f.includes('.bak') || f.includes('.sedtmp')).length, 0);
  } finally { p.cleanup(); }
});

test('deploy: DEPLOY_REVISION from the environment wins; a dirty work tree adds -dirty', () => {
  const p = deployedProject();
  try {
    let r = p.run(['prod', '--target=back'], { DEPLOY_REVISION: 'v9.9', SKIP_UPDATE_COMMON: '1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(p.logLines().includes('ENV_SNAPSHOT: DEPLOY_REVISION=v9.9'));
    r = p.run(['prod', '--target=back'], { STUB_GIT_DIRTY: '1', SKIP_UPDATE_COMMON: '1' });
    assert.equal(r.status, 0, r.out);
    assert.ok(p.logLines().includes('ENV_SNAPSHOT: DEPLOY_REVISION=abc1234-dirty'));
  } finally { p.cleanup(); }
});

test('deploy: unhealthy back -> automatic rollback (retag, env, SQLite restore, maintenance off), exit 3', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolling back to previous version$/m);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolled back to previous version$/m);
    assert.match(out, /^==> Deployment failed, previous version restored$/m);
    assert.doesNotMatch(out, /Rollback failed/);
    const lines = p.logLines();
    const rb = indexOfLine(lines, /^docker .* tag testapp_back:previous testapp_back:latest$/);
    assert.ok(rb > indexOfLine(lines, /^docker .*compose .* up -d /), 'rollback after the failed up');
    assert.equal(p.image('testapp_back:latest'), 'v1');
    assert.ok(indexOfLine(lines, /^ssh .*cp -p \.env\.previous \.env/, rb) >= 0, 'env restored');
    assert.ok(indexOfLine(lines, /^docker .* run --rm .*RESTORE_OK/, rb) >= 0, 'SQLite backup restored (new back never served)');
    assert.ok(indexOfLine(lines, /^docker .*compose .* up -d --no-build back back-lb$/, rb) >= 0, 'up without build');
    assert.ok(indexOfLine(lines, /rm -f \/etc\/nginx\/maintenance\.flag/, rb) >= 0, 'maintenance off');
  } finally { p.cleanup(); }
});

test('deploy: a command failing after maintenance was enabled also rolls back (ERR trap)', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_UP_FAIL: '1' });
    // `up` fails for the new AND the rollback (stub fails every up): rollback impossible -> 4
    assert.equal(r.status, 4, r.out);
    assert.match(strip(r.stdout), /^==> \[BACK:10\.0\.0\.1\] Rollback failed$/m);
    assert.match(strip(r.stdout), /^==> Deployment failed, rollback failed$/m);
  } finally { p.cleanup(); }
});

test('deploy: no previous image (first deploy) + unhealthy back -> Rollback failed, exit 4', () => {
  const p = makeProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 4, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rollback failed$/m);
    assert.match(out, /^==> Deployment failed, rollback failed$/m);
    assert.doesNotMatch(out, /Deployment failed, previous version restored/);
    assert.equal(indexOfLine(p.logLines(), /^docker .* run --rm /), -1, 'no volume yet: no backup attempted');
  } finally { p.cleanup(); }
});

test('deploy: the rollback itself unhealthy -> Rollback failed, exit 4', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad', STUB_ROLLBACK_UNHEALTHY: '1' });
    assert.equal(r.status, 4, r.out);
    assert.match(strip(r.stdout), /^==> \[BACK:10\.0\.0\.1\] Rollback failed$/m);
    assert.match(strip(r.stdout), /^==> Deployment failed, rollback failed$/m);
  } finally { p.cleanup(); }
});

test('deploy: a failing database backup aborts and rolls back', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_RUN_FAIL: '1' });
    assert.ok(r.status === 3 || r.status === 4, r.out);
    assert.match(r.out, /SQLite backup failed/);
    // the new back must never have been started
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^docker .*compose .* up -d back back-lb$/), -1);
  } finally { p.cleanup(); }
});

test('deploy --no-auto-rollback: exit 1, nothing rolled back', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--no-auto-rollback', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 1, r.out);
    assert.equal(indexOfLine(p.logLines(), /tag testapp_back:previous testapp_back:latest/), -1);
    assert.doesNotMatch(strip(r.stdout), /Rolling back/);
    assert.equal(p.image('testapp_back:latest'), 'new');
  } finally { p.cleanup(); }
});

test('deploy: cloud database -> warning, no backup; Postgres dumps only with --migrate', () => {
  const cloud = deployedProject({ engine: 'supabase' });
  try {
    const r = cloud.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /^==> \[BACK:10\.0\.0\.1\] Backing up database$/m);
    assert.match(strip(r.out), /no automatic backup/);
    assert.equal(indexOfLine(cloud.logLines(), /^docker .* run --rm /), -1);
  } finally { cloud.cleanup(); }

  const pg = deployedProject({ engine: 'postgres' });
  try {
    let r = pg.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /pre-deploy dump skipped/);
    assert.equal(existsSync(path.join(pg.root, 'backups')), false);

    r = pg.run(['prod', '--no-update-common', '--migrate', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const dumps = readdirSync(path.join(pg.root, 'backups/deploy-prod'));
    assert.equal(dumps.length, 1, 'local copy of the server dump');
    assert.match(dumps[0], /^testapp_pre-abc1234_\d{8}T\d{6}Z\.dump$/);
    assert.match(strip(r.out), /No automatic restore for Postgres/);
    assert.match(strip(r.out), /pg_restore --clean --if-exists/);
  } finally { pg.cleanup(); }
});

test('deploy: colocated Redis and self-hosted Postgres keep the internal-hostname env patches', () => {
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'REDIS_HOST=10.0.0.1\nREDIS_URL=redis://public\nREDIS_PASSWORD=pw' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.ok(lines.includes('ENV_SNAPSHOT: REDIS_URL=redis://:pw@redis:6379'));
    assert.ok(lines.includes('ENV_SNAPSHOT: DB_HOST=db'));
    assert.ok(lines.includes('ENV_SNAPSHOT: DB_PORT=5432'));
    assert.ok(lines.includes('ENV_SNAPSHOT: SERVER_IP=10.0.0.1'));
    assert.ok(indexOfLine(lines, /compose .* rm -sf back back-worker$/) >= 0, 'db and redis are never stopped by a switch');
    assert.equal(indexOfLine(lines, /compose .* rm -sf .*\b(db|redis)\b/), -1);
    assert.ok(indexOfLine(lines, /compose .* up -d back back-lb db redis$/) >= 0, 'up list includes db and redis (recreated only if changed)');
  } finally { p.cleanup(); }
});

test('deploy: a front that does not start is rolled back (FRONT markers), exit 3', () => {
  const p = makeProject();
  p.seedImage(`${FRONT_PROJECT}-front:latest`, 'f1');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=front'], { STUB_FRONT_FAIL: '1' });
    assert.equal(r.status, 3, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[FRONT:10\.0\.0\.2\] Tagging current images as previous$/m);
    assert.match(out, /^==> \[FRONT:10\.0\.0\.2\] Rolling back to previous version$/m);
    assert.match(out, /^==> \[FRONT:10\.0\.0\.2\] Rolled back to previous version$/m);
    assert.match(out, /^==> Deployment failed, previous version restored$/m);
    assert.equal(p.image(`${FRONT_PROJECT}-front:latest`), 'f1');
  } finally { p.cleanup(); }
});

test('manual rollback swaps latest and previous (images, env, state), restores the SQLite backup; twice rolls forward', () => {
  const p = makeProject();
  p.seedImage('testapp_back:latest', 'v2');
  p.seedImage('testapp_back:previous', 'v1');
  p.seedVolume(`${BACK_PROJECT}_sqlite_data`);
  const currentJson = path.join(p.root, 'current.json');
  writeFileSync(currentJson, '{"revision":"v2","environment":"prod","date":"2026-10-18T10:00:00Z","dbBackup":"/data/backups/testapp-pre-v2-20261018T100000Z.db"}\n');
  try {
    let r = p.run(['rollback', 'prod', '--restore-db', '--target=back'], { STUB_CURRENT_JSON: currentJson });
    assert.equal(r.status, 0, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolling back to previous version$/m);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolled back to previous version$/m);
    assert.match(out, /^==> Rollback completed$/m);
    assert.equal(p.image('testapp_back:latest'), 'v1');
    assert.equal(p.image('testapp_back:previous'), 'v2');
    assert.equal(p.image('testapp_back:rollback-tmp'), null);
    let lines = p.logLines();
    assert.ok(indexOfLine(lines, /^ssh .*mv -f \.env\.previous \.env/) >= 0, 'env swapped');
    assert.ok(indexOfLine(lines, /^ssh .*mv -f current\.json \.swap\.json/) >= 0, 'state swapped');
    assert.ok(indexOfLine(lines, /^docker .* run --rm .*RESTORE_OK.* \/data\/backups\/testapp-pre-v2-20261018T100000Z\.db \/data\/testapp\.db$/) >= 0, 'recorded backup restored');
    assert.ok(indexOfLine(lines, /^docker .*compose .* up -d --no-build /) >= 0);
    assert.ok(indexOfLine(lines, /touch \/etc\/nginx\/maintenance\.flag/) >= 0, 'maintenance on');
    assert.ok(indexOfLine(lines, /rm -f \/etc\/nginx\/maintenance\.flag/) >= 0, 'maintenance off');
    assert.equal(indexOfLine(lines, /compose .* build /), -1, 'never builds');
    assert.equal(indexOfLine(lines, /^update_common\.sh/), -1);
    assert.equal(indexOfLine(lines, /^git .*submodule/), -1);
    assert.equal(indexOfLine(lines, /^npm /), -1);
    assert.ok(lines.includes('ENV_SNAPSHOT: FROM_REMOTE=1'), 'container env comes from the restored remote .env');
    assert.ok(lines.includes('ENV_SNAPSHOT: SERVER_IP=10.0.0.1'), 'host patches re-applied');

    r = p.run(['rollback', 'prod', '--target=back']); // second time: rolls forward
    assert.equal(r.status, 0, r.out);
    assert.equal(p.image('testapp_back:latest'), 'v2');
    assert.equal(p.image('testapp_back:previous'), 'v1');
    lines = p.logLines();
    assert.equal(lines.filter((l) => /RESTORE_OK/.test(l)).length, 1, 'no restore without --restore-db');
  } finally { p.cleanup(); }
});

test('manual rollback: --restore-db without a recorded backup refuses before changing anything', () => {
  const p = makeProject();
  p.seedImage('testapp_back:latest', 'v2');
  p.seedImage('testapp_back:previous', 'v1');
  try {
    const r = p.run(['rollback', 'prod', '--restore-db', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /records no database backup/);
    assert.equal(p.image('testapp_back:latest'), 'v2');
  } finally { p.cleanup(); }
});

test('manual rollback: unhealthy previous version -> Rollback failed, non-zero (never 3/4)', () => {
  const p = makeProject();
  p.seedImage('testapp_back:latest', 'v2');
  p.seedImage('testapp_back:previous', 'v1');
  try {
    const r = p.run(['rollback', 'prod', '--target=back'], { STUB_ROLLBACK_UNHEALTHY: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.stdout), /^==> \[BACK:10\.0\.0\.1\] Rollback failed$/m);
    assert.doesNotMatch(strip(r.stdout), /Rollback completed/);
  } finally { p.cleanup(); }
});

test('manual rollback of the front swaps its images', () => {
  const p = makeProject();
  p.seedImage(`${FRONT_PROJECT}-front:latest`, 'f2');
  p.seedImage(`${FRONT_PROJECT}-front:previous`, 'f1');
  try {
    const r = p.run(['rollback', 'prod', '--target=front']);
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.stdout), /^==> \[FRONT:10\.0\.0\.2\] Rolled back to previous version$/m);
    assert.equal(p.image(`${FRONT_PROJECT}-front:latest`), 'f1');
    assert.equal(p.image(`${FRONT_PROJECT}-front:previous`), 'f2');
  } finally { p.cleanup(); }
});

// ---------------------------------------------------------------------------
// back-worker sequencing (only `back` manages the schema) and BACK_WORKER=on|off
// ---------------------------------------------------------------------------
const WORKER_START = /^docker .*compose .* up -d --no-build --no-deps back-worker$/;
const HEALTH_WAIT = /compose .* ps --format \{\{\.Health\}\} back$/;
const MAINT_OFF = /rm -f \/etc\/nginx\/maintenance\.flag/;

test('deploy BACK_WORKER on (default): up without back-worker, health wait, then back-worker, then maintenance off', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Starting back-worker \(after back is healthy\)$/m);
    assert.doesNotMatch(out, /back-worker disabled/);
    const lines = p.logLines();
    const build = indexOfLine(lines, /^docker .*compose .* build --pull back back-worker$/);
    const up = indexOfLine(lines, /^docker .*compose .* up -d back back-lb$/);
    const health = indexOfLine(lines, HEALTH_WAIT, up);
    const worker = indexOfLine(lines, WORKER_START);
    const maintOff = indexOfLine(lines, MAINT_OFF);
    assert.ok(build >= 0, 'both services built');
    assert.ok(up >= 0 && health > up, 'up (no worker) then health wait');
    assert.ok(worker > health, 'back-worker started after back is healthy');
    assert.ok(maintOff > worker, 'maintenance lifted after the worker start');
    assert.equal(indexOfLine(lines, /^COMPOSE_ENV\[(up|build)\]: BACK_NODE_ROLE=.+$/), -1, 'BACK_NODE_ROLE unset');
    // the worker is started while the host-patched back/.env is still staged (same env as back)
    assert.ok(indexOfLine(lines, /^ENV_SNAPSHOT: SERVER_IP=10\.0\.0\.1$/, worker) > worker);
    assert.equal(readdirSync(p.root).filter((f) => f.includes('.bak')).length, 0);
  } finally { p.cleanup(); }
});

test('deploy BACK_WORKER=off: only back built, back-worker removed not started, back runs with NODE_ROLE=all', () => {
  for (const value of ['off', 'OFF', 'false', '0']) {
    const p = deployedProject({ extraBackEnv: `BACK_WORKER=${value}` });
    try {
      const r = p.run(['prod', '--no-update-common', '--target=back']);
      assert.equal(r.status, 0, `${value}: ${r.out}`);
      assert.match(strip(r.stdout), /^==> \[BACK:10\.0\.0\.1\] back-worker disabled \(BACK_WORKER=off\): removed if present$/m);
      assert.doesNotMatch(strip(r.stdout), /Starting back-worker/);
      const lines = p.logLines();
      assert.ok(indexOfLine(lines, /^docker .*compose .* build --pull back$/) >= 0, 'only back built');
      assert.equal(indexOfLine(lines, /compose .* build .*back-worker/), -1);
      assert.ok(indexOfLine(lines, /compose .* rm -sf back back-worker$/) >= 0, 'existing worker removed by the switch');
      assert.equal(indexOfLine(lines, /compose .* up .*back-worker/), -1, 'back-worker never started');
      assert.ok(indexOfLine(lines, /compose .* up -d back back-lb$/) >= 0);
      assert.ok(lines.includes('COMPOSE_ENV[up]: BACK_NODE_ROLE=all'), 'BACK_NODE_ROLE=all reaches compose');
      assert.ok(lines.includes('COMPOSE_ENV[build]: BACK_NODE_ROLE=all'));
    } finally { p.cleanup(); }
  }
});

test('deploy BACK_WORKER accepts on/true/1 (worker started)', () => {
  for (const value of ['on', 'TRUE', '1']) {
    const p = deployedProject({ extraBackEnv: `BACK_WORKER=${value}` });
    try {
      const r = p.run(['prod', '--no-update-common', '--target=back']);
      assert.equal(r.status, 0, `${value}: ${r.out}`);
      assert.ok(indexOfLine(p.logLines(), WORKER_START) >= 0, value);
    } finally { p.cleanup(); }
  }
});

test('deploy: an invalid BACK_WORKER value exits 1 before any host is touched', () => {
  const p = deployedProject({ extraBackEnv: 'BACK_WORKER=maybe' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /BACK_WORKER='maybe' is not valid/);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /^(ssh|scp|rsync|docker) /), -1, 'no remote call');
  } finally { p.cleanup(); }
});

test('deploy: back-worker failing to start after the switch -> automatic rollback, exit 3', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_WORKER_FAIL: 'new' });
    assert.equal(r.status, 3, r.out);
    const out = strip(r.stdout);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolling back to previous version$/m);
    assert.match(out, /^==> \[BACK:10\.0\.0\.1\] Rolled back to previous version$/m);
    assert.match(out, /^==> Deployment failed, previous version restored$/m);
    assert.match(strip(r.out), /back-worker did not start/);
    assert.equal(p.image('testapp_back:latest'), 'v1');
    const lines = p.logLines();
    const failedWorker = indexOfLine(lines, WORKER_START);
    const rb = indexOfLine(lines, /^docker .* tag testapp_back:previous testapp_back:latest$/);
    assert.ok(failedWorker >= 0 && rb > failedWorker, 'rollback after the failed worker start');
    assert.ok(indexOfLine(lines, MAINT_OFF) > rb, 'maintenance never lifted before the rollback');
    assert.ok(indexOfLine(lines, /^docker .* run --rm .*RESTORE_OK/, rb) >= 0, 'SQLite backup restored (back never served)');
    assert.ok(indexOfLine(lines, WORKER_START, rb) >= 0, 'previous worker started again by the rollback');
  } finally { p.cleanup(); }
});

test('deploy: back-worker failing to start in the rollback too -> Rollback failed, exit 4', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_WORKER_FAIL: '1' });
    assert.equal(r.status, 4, r.out);
    assert.match(strip(r.stdout), /^==> Deployment failed, rollback failed$/m);
  } finally { p.cleanup(); }
});

test('deploy rollback path, worker on: up without back-worker, health, then back-worker, then maintenance off', () => {
  const p = deployedProject();
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    const lines = p.logLines();
    const rb = indexOfLine(lines, /^docker .* tag testapp_back:previous testapp_back:latest$/);
    const up = indexOfLine(lines, /^docker .*compose .* up -d --no-build back back-lb$/, rb);
    const health = indexOfLine(lines, HEALTH_WAIT, up);
    const worker = indexOfLine(lines, WORKER_START, rb);
    const maintOff = indexOfLine(lines, MAINT_OFF, rb);
    assert.ok(rb >= 0 && up > rb && health > up && worker > health && maintOff > worker, `${rb} ${up} ${health} ${worker} ${maintOff}`);
    assert.equal(indexOfLine(lines, WORKER_START), worker, 'no worker start for the unhealthy new version');
  } finally { p.cleanup(); }
});

test('deploy rollback path, worker off: back-worker removed, never started, NODE_ROLE=all', () => {
  const p = deployedProject({ extraBackEnv: 'BACK_WORKER=off' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    const lines = p.logLines();
    const rb = indexOfLine(lines, /^docker .* tag testapp_back:previous testapp_back:latest$/);
    assert.ok(rb >= 0);
    assert.equal(lines.filter((l) => /compose .* rm -sf back back-worker$/.test(l)).length, 2, 'worker removed by the switch AND by the rollback');
    assert.ok(indexOfLine(lines, /^docker .*compose .* up -d --no-build back back-lb$/, rb) >= 0);
    assert.equal(indexOfLine(lines, /compose .* up .*back-worker/), -1);
    assert.ok(lines.slice(rb).includes('COMPOSE_ENV[up]: BACK_NODE_ROLE=all'));
    assert.match(strip(r.stdout), /back-worker disabled \(BACK_WORKER=off\): removed if present/);
  } finally { p.cleanup(); }
});

test('manual rollback follows BACK_WORKER (on: worker after health; off: NODE_ROLE=all, no worker)', () => {
  for (const off of [false, true]) {
    const p = makeProject({ extraBackEnv: off ? 'BACK_WORKER=off' : '' });
    p.seedImage('testapp_back:latest', 'v2');
    p.seedImage('testapp_back:previous', 'v1');
    try {
      const r = p.run(['rollback', 'prod', '--target=back']);
      assert.equal(r.status, 0, r.out);
      const lines = p.logLines();
      if (off) {
        assert.equal(indexOfLine(lines, /compose .* up .*back-worker/), -1);
        assert.ok(lines.includes('COMPOSE_ENV[up]: BACK_NODE_ROLE=all'));
      } else {
        const health = indexOfLine(lines, HEALTH_WAIT);
        assert.ok(health >= 0 && indexOfLine(lines, WORKER_START) > health);
        assert.equal(indexOfLine(lines, /^COMPOSE_ENV\[up\]: BACK_NODE_ROLE=.+$/), -1);
      }
    } finally { p.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Deploy speed: database backups, switch order, Docker context, timing, SSH reuse, library sync
// ---------------------------------------------------------------------------
const MAINT_ON = /touch \/etc\/nginx\/maintenance\.flag/;
const PG_DUMP = /^ssh .*docker exec 'testapp_postgres' pg_dump .*--format=custom/;

test('Postgres (sync): dump on the server BEFORE maintenance while the old back serves, db never stopped, local copy', () => {
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'DB_SCHEMA_MODE=sync' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    const build = indexOfLine(lines, /^docker .*compose .* build /);
    const dump = indexOfLine(lines, PG_DUMP);
    const maintOn = indexOfLine(lines, MAINT_ON);
    const stop = indexOfLine(lines, /compose .* rm -sf back back-worker$/);
    assert.ok(build >= 0 && dump > build, 'dump after the build');
    assert.ok(maintOn > dump && stop > maintOn, 'dump before maintenance and before the old back stops');
    assert.match(lines[dump], /> '\/srv\/testapp\/back\/backups\/testapp_pre-abc1234_\d{8}T\d{6}Z\.dump\.part'/, 'written on the server');
    assert.ok(indexOfLine(lines, /^ssh .*ls -1t '\/srv\/testapp\/back\/backups'\/testapp_pre-\*\.dump .*tail -n \+3/) > dump, 'server keeps 2');
    assert.equal(indexOfLine(lines, /compose .* up -d db$/), -1, 'running db not restarted for the dump');
    const state = JSON.parse(lines.find((l) => l.startsWith('STATE_JSON: ')).slice('STATE_JSON: '.length));
    assert.match(state.dbBackup, /^\/srv\/testapp\/back\/backups\/testapp_pre-abc1234_\d{8}T\d{6}Z\.dump$/);
    const scp = indexOfLine(lines, /^scp .*deploy@10\.0\.0\.1:\/srv\/testapp\/back\/backups\/testapp_pre-abc1234_.*\.dump /);
    assert.ok(scp > indexOfLine(lines, MAINT_OFF), 'local copy after maintenance is lifted');
    assert.equal(readdirSync(path.join(p.root, 'backups/deploy-prod')).length, 1);
  } finally { p.cleanup(); }
});

test('Postgres dump: zstd:9 by default (gzip fallback decided on the server), DEPLOY_DB_BACKUP_COMPRESSION overrides it', () => {
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'DB_SCHEMA_MODE=sync' });
  try {
    let r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    let dump = p.logLines().find((l) => PG_DUMP.test(l));
    assert.match(dump, /comp='zstd:9'/);
    assert.match(dump, /pg_config --configure .*--with-zstd' \|\| comp=gzip:6/, 'fallback when the server lacks zstd');
    assert.match(dump, /--compress="\$comp"/);
    assert.match(strip(r.out), /Postgres dump written: zstd:9, 3 MiB/);

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common', '--force-db-backup', '--target=back'], { DEPLOY_DB_BACKUP_COMPRESSION: 'gzip:9' });
    assert.equal(r.status, 0, r.out);
    dump = p.logLines().find((l) => PG_DUMP.test(l));
    assert.match(dump, /comp='gzip:9'/);
  } finally { p.cleanup(); }
});

test('local npm install: skipped when package.json, package-lock.json and Node are unchanged; DEPLOY_NPM_INSTALL=always forces it', () => {
  const p = deployedProject();
  for (const stack of ['back', 'front']) {
    mkdirSync(path.join(p.root, stack, 'node_modules'), { recursive: true });
    writeFileSync(path.join(p.root, stack, 'package-lock.json'), '{"lockfileVersion":3}\n');
  }
  const installs = () => p.logLines().filter((l) => /^npm install/.test(l)).length;
  try {
    let r = p.run(['prod', '--no-update-common']);
    assert.equal(r.status, 0, r.out);
    assert.equal(installs(), 2, 'first deploy installs both stacks');
    assert.ok(p.logLines().includes('npm install --no-audit --no-fund'));

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common']);
    assert.equal(r.status, 0, r.out);
    assert.equal(installs(), 0, 'nothing changed: no install');
    assert.match(strip(r.out), /back: package\.json, package-lock\.json and Node unchanged since the last install — npm install skipped/);
    assert.ok(p.logLines().some((l) => /^npm run build/.test(l)), 'the build still runs');

    writeFileSync(p.log, '');
    writeFileSync(path.join(p.root, 'back/package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    r = p.run(['prod', '--no-update-common']);
    assert.equal(r.status, 0, r.out);
    assert.equal(installs(), 1, 'only the stack whose lock changed');

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common'], { DEPLOY_NPM_INSTALL: 'always' });
    assert.equal(r.status, 0, r.out);
    assert.equal(installs(), 2);
  } finally { p.cleanup(); }
});

test('Postgres: a dump younger than DEPLOY_DB_BACKUP_MIN_AGE_HOURS is reused; --force-db-backup and --migrate dump anyway', () => {
  const recent = '/srv/testapp/back/backups/testapp_pre-old1234_20261021T080000Z.dump';
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'DB_SCHEMA_MODE=sync' });
  try {
    let r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_RECENT_DUMP: recent });
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /less than 24 h old .*no new dump/);
    let lines = p.logLines();
    assert.ok(indexOfLine(lines, /^ssh .*-mmin -1440 /) >= 0, '24 h by default');
    assert.equal(indexOfLine(lines, PG_DUMP), -1);
    const state = JSON.parse(lines.find((l) => l.startsWith('STATE_JSON: ')).slice('STATE_JSON: '.length));
    assert.equal(state.dbBackup, recent, 'the reused dump is the recorded safety net');

    for (const flag of ['--force-db-backup', '--migrate']) {
      writeFileSync(p.log, '');
      r = p.run(['prod', '--no-update-common', flag, '--target=back'], { STUB_RECENT_DUMP: recent });
      assert.equal(r.status, 0, `${flag}: ${r.out}`);
      lines = p.logLines();
      assert.equal(indexOfLine(lines, /-mmin/), -1, `${flag}: age not even checked`);
      assert.ok(indexOfLine(lines, PG_DUMP) >= 0, `${flag}: dumped`);
    }

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_RECENT_DUMP: recent, DEPLOY_DB_BACKUP_MIN_AGE_HOURS: '0' });
    assert.equal(r.status, 0, r.out);
    assert.ok(indexOfLine(p.logLines(), PG_DUMP) >= 0, 'MIN_AGE 0 = every deploy');
  } finally { p.cleanup(); }
});

test('Postgres: a failed dump stops the deploy BEFORE the switch (exit 1, no maintenance, latest re-tagged)', () => {
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'DB_SCHEMA_MODE=sync' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_PGDUMP_FAIL: '1' });
    assert.equal(r.status, 1, r.out);
    assert.match(strip(r.out), /deploy stopped before the switch/);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, MAINT_ON), -1);
    assert.equal(indexOfLine(lines, /compose .* (rm -sf|up -d) /), -1, 'nothing stopped or started');
    assert.equal(p.image('testapp_back:latest'), 'v1', 'latest points again at the running version');
    assert.ok(indexOfLine(lines, /^ssh .*rm -f '\/srv\/testapp\/back\/backups\/.*\.dump\.part'/) >= 0, 'partial dump removed');
  } finally { p.cleanup(); }
});

test('Postgres: no db container yet (first deploy) -> no dump, deploy goes on', () => {
  const p = deployedProject({ engine: 'postgres', extraBackEnv: 'DB_SCHEMA_MODE=sync' });
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_PG: 'absent' });
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /No Postgres container \(testapp_postgres\) yet/);
    assert.equal(indexOfLine(p.logLines(), PG_DUMP), -1);
  } finally { p.cleanup(); }
});

test('backups: 2 kept by default on the volume (SQLite) and locally; a recent local copy is not downloaded again', () => {
  const p = deployedProject();
  const local = path.join(p.root, 'backups/deploy-prod');
  mkdirSync(local, { recursive: true });
  const old = Date.now() / 1000 - 3 * 86400;
  for (const [i, name] of ['testapp-pre-a-20261001T000000Z.db.tar', 'testapp-pre-b-20261002T000000Z.db.tar.gz', 'other-pre-c.db.tar'].entries()) {
    writeFileSync(path.join(local, name), 'x');
    utimesSync(path.join(local, name), old + i, old + i);
  }
  try {
    let r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    const backup = lines.find((l) => /^docker .* run --rm --entrypoint sh -v .*BACKUP_OK/.test(l));
    assert.match(backup, / 2$/, 'keep count passed to the volume backup');
    const files = readdirSync(local).sort();
    assert.equal(files.length, 3, files.join(','));
    assert.ok(files.includes('testapp-pre-b-20261002T000000Z.db.tar.gz') && files.includes('other-pre-c.db.tar'), 'oldest (a legacy plain copy) pruned, other projects untouched');
    const copy = files.find((f) => /^testapp-pre-abc1234-\d{8}T\d{6}Z\.db\.tar\.gz$/.test(f));
    assert.ok(copy);
    // a fast second run may land in the same second (same backup name): rename the fresh copy so the age rule is hit
    renameSync(path.join(local, copy), path.join(local, 'testapp-pre-abc1234-20000101T000000Z.db.tar.gz'));

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /local backup copy younger than 24 h exists/);
    assert.equal(indexOfLine(p.logLines(), /tar -cf/), -1);

    r = p.run(['prod', '--no-update-common', '--target=back'], { DEPLOY_DB_BACKUP_DOWNLOAD: '0' });
    assert.match(strip(r.out), /Local copy of the database backups disabled/);
  } finally { p.cleanup(); }
});

test('SQLite local copy: gzip-compressed in the container before the transfer (level 6 by default), a valid .db.tar.gz', () => {
  const p = deployedProject();
  const local = path.join(p.root, 'backups/deploy-prod');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    const copy = readdirSync(local).find((f) => /^testapp-pre-abc1234-\d{8}T\d{6}Z\.db\.tar\.gz$/.test(f));
    assert.ok(copy, readdirSync(local).join(','));
    assert.equal(spawnSync('tar', ['-tzf', path.join(local, copy)]).status, 0, 'the copy is a readable tar.gz');
    assert.equal(spawnSync('tar', ['-xzOf', path.join(local, copy), 'testapp.db'], { encoding: 'utf8' }).stdout, 'TARDATA');
    const fetch = p.logLines().find((l) => /\| gzip -"\$2"/.test(l));
    assert.ok(fetch, 'the tar runs through gzip in the container');
    assert.match(fetch, /sh \/data\/backups\/testapp-pre-abc1234-\d{8}T\d{6}Z\.db 6$/, 'level 6 passed to the container');
    assert.equal(readdirSync(local).filter((f) => f.endsWith('.part')).length, 0);
  } finally { p.cleanup(); }
});

test('SQLite local copy: DEPLOY_DB_BACKUP_COMPRESSION gzip:<level> sets the level, none keeps a plain .db.tar, others give gzip:6', () => {
  for (const [value, ext, level] of [['gzip:9', '.db.tar.gz', '9'], ['none', '.db.tar', ''], ['zstd:19', '.db.tar.gz', '6'], ['gzip:12', '.db.tar.gz', '6']]) {
    const p = deployedProject();
    const local = path.join(p.root, 'backups/deploy-prod');
    try {
      const r = p.run(['prod', '--no-update-common', '--target=back'], { DEPLOY_DB_BACKUP_COMPRESSION: value });
      assert.equal(r.status, 0, `${value}: ${r.out}`);
      const files = readdirSync(local);
      assert.ok(files.some((f) => f.endsWith(ext) && !f.endsWith('.part')), `${value}: ${files.join(',')}`);
      assert.ok(!files.some((f) => f.endsWith(ext === '.db.tar' ? '.db.tar.gz' : '.db.tar')), `${value}: only one kind of copy`);
      const fetch = p.logLines().find((l) => /\| gzip -"\$2"/.test(l));
      assert.ok(fetch, `${value}: copy made`);
      assert.match(fetch, new RegExp(`\\.db${level ? ` ${level}` : ''}$`), `${value}: level "${level}" passed (none = no level argument)`);
    } finally { p.cleanup(); }
  }
});

test('SQLite local copy: a stream cut short is detected (tar -tzf), nothing is kept, the deploy still succeeds', () => {
  const p = deployedProject();
  const local = path.join(p.root, 'backups/deploy-prod');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_TAR_CUT: '1' });
    assert.equal(r.status, 0, r.out);
    assert.match(strip(r.out), /Could not copy .* locally/);
    assert.deepEqual(existsSync(local) ? readdirSync(local) : [], [], 'no truncated copy left behind');
  } finally { p.cleanup(); }
});

test('local copies: an interrupted *.part file is neither a recent copy nor counted for the pruning', () => {
  const p = deployedProject();
  const local = path.join(p.root, 'backups/deploy-prod');
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, 'testapp-pre-zzz-20990101T000000Z.db.tar.gz.part'), 'x');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(strip(r.out), /younger than/);
    assert.ok(readdirSync(local).some((f) => /^testapp-pre-abc1234-.*\.db\.tar\.gz$/.test(f)), 'the copy was made despite the leftover .part');
  } finally { p.cleanup(); }
});

test('switch: only containers of ANOTHER compose project are removed (never the running ones of this project)', () => {
  const p = deployedProject();
  const lines = [
    `id1 testapp_front ${BACK_PROJECT}`,
    `id2 testapp_redis ${BACK_PROJECT}`,
    'id3 testapp_redis oldname-back-x',
    'id4 something testapp-back-oldhost',
    'id5 unrelated otherapp',
  ].join('\\n');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_PS_LINES: lines });
    assert.equal(r.status, 0, r.out);
    const log = p.logLines();
    assert.ok(indexOfLine(log, /^docker .* rm -f id3$/) >= 0, 'fixed name held by another project');
    assert.ok(indexOfLine(log, /^docker .* rm -f id4$/) >= 0, 'older back project name of this app');
    for (const id of ['id1', 'id2', 'id5']) assert.equal(indexOfLine(log, new RegExp(`rm -f ${id}$`)), -1, id);
    assert.equal(log.filter((l) => /^docker .* ps -a --format /.test(l)).length, 1, 'one docker ps for the whole scan');
  } finally { p.cleanup(); }
});

test('front: recreated in place by `up -d` (no stop/down beforehand); dedicated host gets --remove-orphans', () => {
  const p = makeProject();
  p.seedImage(`${FRONT_PROJECT}-front:latest`, 'f1');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=front']);
    assert.equal(r.status, 0, r.out);
    const lines = p.logLines();
    assert.equal(indexOfLine(lines, /compose .* (rm -sf front|down)/), -1);
    assert.ok(indexOfLine(lines, /compose .* up -d --remove-orphans front$/) >= 0);
  } finally { p.cleanup(); }
});

test('prebuilt stacks ship the template Dockerfile.prebuilt + whitelist .dockerignore (no src/.libs in the context)', () => {
  const p = deployedProject();
  const template = path.dirname(SCRIPTS_DIR);
  try {
    const r = p.run(['prod', '--no-update-common'], { KEEP_BUILD_CONTEXT: '1' });
    assert.equal(r.status, 0, r.out);
    const ctx = strip(r.out).match(/Build context staged at (\S+)/)[1];
    for (const stack of ['back', 'front']) {
      assert.equal(readFileSync(path.join(ctx, stack, 'Dockerfile'), 'utf8'), readFileSync(path.join(template, stack, 'Dockerfile.prebuilt'), 'utf8'), stack);
      const ignore = readFileSync(path.join(ctx, stack, '.dockerignore'), 'utf8');
      assert.equal(ignore, readFileSync(path.join(template, stack, '.dockerignore.prebuilt'), 'utf8'), stack);
      assert.match(ignore, /^\*$/m, `${stack}: whitelist`);
    }
    assert.equal(existsSync(path.join(ctx, 'back', 'Dockerfile.selfhosted')), false, 'one Dockerfile name for both compose files');
  } finally { p.cleanup(); }
});

test('timing: [TIME] lines and a summary including run.sh phases (also on failure)', () => {
  const p = deployedProject();
  try {
    let r = p.run(['prod', '--target=back']);
    assert.equal(r.status, 0, r.out);
    let out = strip(r.out);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: image build on the server .*: \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: {3}new back started and healthy \(up \+ boot\): \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: {3}stop old back back-worker \(graceful shutdown\): \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: {3}leftover containers scan: \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: {3}SQLite backup: \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: {3}back-lb reload \+ maintenance off: \d+s$/m);
    assert.match(out, /^==> \[TIME\] back 10\.0\.0\.1: maintenance window total \(requests answered 503\): \d+s$/m);
    assert.match(out, /^==> \[TIME\] back: build \(local, nest build\): \d+s$/m);
    assert.match(out, /^==> \[TIME\] Summary$/m);
    assert.match(out, /^ {4}update_common\.sh \(library sync\) +\d+s$/m, 'run.sh phase imported');
    assert.match(out, /^ {4}total +\d+s$/m);

    p.seedImage('testapp_back:latest', 'v1'); // the run above made `new` the running version: restore a sane v1
    r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_BACK_HEALTH: 'bad' });
    assert.equal(r.status, 3, r.out);
    assert.match(strip(r.out), /^==> \[TIME\] Summary$/m, 'summary printed on failure too');
  } finally { p.cleanup(); }
});

test('ssh reuse: ssh/scp go through ControlMaster wrappers (DEPLOY_SSH_MUX=0 disables them), socket dir removed', () => {
  const p = deployedProject();
  try {
    let r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 0, r.out);
    let lines = p.logLines();
    const sshLines = lines.filter((l) => /^(ssh|scp) /.test(l));
    assert.ok(sshLines.length > 0 && sshLines.every((l) => /-o ControlMaster=auto -o ControlPath=\/tmp\/vxmux\.\w+\/%C -o ControlPersist=120/.test(l)), sshLines[0]);
    const dir = sshLines[0].match(/ControlPath=(\/tmp\/vxmux\.\w+)\//)[1];
    assert.equal(existsSync(dir), false, 'socket dir cleaned at exit');

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common', '--target=back'], { DEPLOY_SSH_MUX: '0' });
    assert.equal(r.status, 0, r.out);
    lines = p.logLines();
    assert.equal(lines.filter((l) => /ControlMaster/.test(l)).length, 0);
  } finally { p.cleanup(); }
});

test('library sync: after update_common.sh the submodules are not fetched again (only a missing one is initialised)', () => {
  const p = deployedProject();
  write(path.join(p.root, '.gitmodules'), '[submodule "back/.libs/vx-public"]\n');
  write(path.join(p.root, 'back/.libs/vx-public/.git'), 'gitdir: x\n');
  try {
    let r = p.run(['prod', '--target=back'], { STUB_GIT_TOP: p.root });
    assert.equal(r.status, 0, r.out);
    assert.equal(indexOfLine(p.logLines(), /^git .*submodule update/), -1, 'synced by update_common: no second fetch');
    assert.match(strip(r.out), /submodules \(init only, synced by update_common\)/);

    writeFileSync(p.log, '');
    rmSync(path.join(p.root, 'back/.libs/vx-public/.git'));
    r = p.run(['prod', '--target=back'], { STUB_GIT_TOP: p.root });
    assert.equal(r.status, 0, r.out);
    assert.ok(indexOfLine(p.logLines(), /^git .*submodule update --init --remote -- back\/\.libs\/vx-public$/) >= 0, 'missing mount initialised');

    writeFileSync(p.log, '');
    r = p.run(['prod', '--no-update-common', '--target=back'], { STUB_GIT_TOP: p.root });
    assert.equal(r.status, 0, r.out);
    assert.ok(indexOfLine(p.logLines(), /^git .*submodule update --init --remote$/) >= 0, 'no sync -> full fetch as before');
  } finally { p.cleanup(); }
});

test('homogeneity: a project copy of a shared Docker file stops the deploy before anything is built', () => {
  const p = deployedProject();
  const template = path.dirname(SCRIPTS_DIR);
  mkdirSync(path.join(p.root, 'back/.libs'), { recursive: true });
  symlinkSync(template, path.join(p.root, 'back/.libs/apptemplate'));
  writeFileSync(path.join(p.root, 'back/Dockerfile'), 'FROM scratch\n');
  try {
    const r = p.run(['prod', '--no-update-common', '--target=back']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /back\/Dockerfile: copie projet/);
    assert.equal(indexOfLine(p.logLines(), /^(docker|ssh|npm) /), -1, 'nothing built, no host contacted');
  } finally { p.cleanup(); }
});

test('portable sed: no BSD-only `sed -i \'\'` left, in-place helpers work and leave no backup file', () => {
  for (const file of ['deploy-full.sh', 'run.sh', 'lib/deploy-versions.sh', 'lib/deploy-timing.sh', 'lib/ssh-mux.sh']) {
    assert.doesNotMatch(readFileSync(path.join(SCRIPTS_DIR, file), 'utf8'), /sed -i ''/, file);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'dv-sed-'));
  try {
    const envFile = path.join(dir, 'a.env');
    writeFileSync(envFile, 'A=1\nSERVER_IP=old\n');
    const deployFull = readFileSync(path.join(SCRIPTS_DIR, 'deploy-full.sh'), 'utf8');
    const fn = deployFull.match(/^portable_sed_inplace\(\) \{[\s\S]*?^\}/m)[0];
    const script = `set -euo pipefail
source "${path.join(SCRIPTS_DIR, 'lib/deploy-versions.sh')}"
${fn}
portable_sed_inplace "${envFile}" "s|^SERVER_IP=.*|SERVER_IP=1.2.3.4|"
dv_env_set "${envFile}" DEPLOY_REVISION abc
dv_env_set "${envFile}" DEPLOY_REVISION def
`;
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(envFile, 'utf8'), 'A=1\nSERVER_IP=1.2.3.4\n\nDEPLOY_REVISION=def\n');
    assert.deepEqual(readdirSync(dir), ['a.env']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every modified shell script passes bash -n; shellcheck when installed', (t) => {
  const files = ['run.sh', 'deploy-full.sh', 'lib/deploy-versions.sh', 'lib/deploy-timing.sh', 'lib/ssh-mux.sh'].map((f) => path.join(SCRIPTS_DIR, f));
  for (const f of files) {
    const res = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${f}: ${res.stderr}`);
  }
  const sc = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (sc.error) {
    t.diagnostic('shellcheck not installed: skipped');
    return;
  }
  const res = spawnSync('shellcheck', ['-S', 'error', '-s', 'bash', ...files], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout);
});

test('runner provisioning: after the healthy back by default; RUNNER_PROVISION_ORDER=before runs it before the new back, again after only when that failed', () => {
  const hook = `#!/usr/bin/env bash
echo "hook \${RUNNER_PROVISION_PHASE:-none} \${RUNNER_TARGET_HOST}" >> "$STUB_LOG"
[ "\${RUNNER_PROVISION_PHASE:-}" = "\${STUB_HOOK_FAIL:-never}" ] && exit 1
exit 0
`;
  const cases = [
    { order: '', fail: '', phases: ['after'] },
    { order: 'RUNNER_PROVISION_ORDER=before', fail: '', phases: ['before'] },
    { order: 'RUNNER_PROVISION_ORDER=before', fail: 'before', phases: ['before', 'after'] },
  ];
  for (const c of cases) {
    const p = deployedProject({ extraBackEnv: `RUNNER_PROVISION=1\nRUNNER_PROVISION_HOOK=./runner-hook.sh\n${c.order}` });
    write(path.join(p.root, 'runner-hook.sh'), hook, 0o755);
    try {
      const r = p.run(['prod', '--no-update-common', '--target=back'], c.fail ? { STUB_HOOK_FAIL: c.fail } : {});
      assert.equal(r.status, 0, r.out);
      const lines = p.logLines();
      assert.deepEqual(lines.filter((l) => l.startsWith('hook ')), c.phases.map((phase) => `hook ${phase} 10.0.0.1`), `${c.order || 'default'} ${c.fail}`);
      const up = indexOfLine(lines, /^docker .*compose .* up -d back back-lb$/);
      const health = indexOfLine(lines, HEALTH_WAIT, up);
      assert.ok(up >= 0 && health > up, 'the back went up then was waited for');
      for (const phase of c.phases) {
        const at = lines.indexOf(`hook ${phase} 10.0.0.1`);
        if (phase === 'before') assert.ok(at >= 0 && at < up, 'the hook ran before the new back went up');
        else assert.ok(at > health, 'the hook ran once the new back was healthy');
      }
      if (c.fail) assert.match(strip(r.out), /Runner auto-provisioning before the back failed — retried once the new back is healthy/);
    } finally { p.cleanup(); }
  }
});
