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
// (STUB_BACK_HEALTH=bad, STUB_ROLLBACK_UNHEALTHY=1, STUB_FRONT_FAIL=1, STUB_RUN_FAIL=1...).
//
// Run: node --test scripts/deploy-versions.test.mjs   (needs bash and python3)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
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
  inspect) case "$1" in *_back_lb) [ "\${STUB_LB:-1}" != 0 ]; exit $? ;; esac; exit 1 ;;
  ps) case "$*" in *"-q -f"*) echo cid123 ;; esac ;;
  volume) if [ "\${1:-}" = inspect ]; then [ -f "$S/vol_$2" ]; exit $?; fi ;;
  run)
    if [ -n "\${STUB_RUN_FAIL:-}" ]; then exit 1; fi
    case "$*" in *RESTORE_OK*) echo RESTORE_OK ;; *BACKUP_OK*) echo BACKUP_OK ;; esac ;;
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
    case "$sub" in
      build)
        case "$*" in *back*) echo new > "$(img "\${PROJECT_NAME}_back:latest")" ;; esac
        case "$*" in *front*) echo new > "$(img "$proj-front:latest")" ;; esac ;;
      up)
        if [ -f "$dir/back/.env" ]; then sed 's/^/ENV_SNAPSHOT: /' "$dir/back/.env" >> "$STUB_LOG"; fi
        if [ -n "\${STUB_UP_FAIL:-}" ]; then exit 1; fi ;;
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
  *show-toplevel*) exit 1 ;;
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
    assert.ok(indexOfLine(lines, /^docker .*compose .* up -d --no-build back back-worker back-lb/, rb) >= 0, 'up without build');
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
    assert.equal(indexOfLine(lines, /^docker .*compose .* up -d back back-worker back-lb$/), -1);
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
    const dumps = readdirSync(path.join(pg.root, 'backups'));
    assert.equal(dumps.length, 1);
    assert.match(dumps[0], /^testapp_pre-abc1234_\d{8}T\d{6}Z\.sql\.gz$/);
    assert.match(strip(r.out), /No automatic restore for Postgres/);
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
    assert.ok(indexOfLine(lines, /compose .* rm -sf back back-worker db redis$/) >= 0, 'stop list includes db and redis');
    assert.ok(indexOfLine(lines, /compose .* up -d back back-worker back-lb db redis$/) >= 0, 'up list includes db and redis');
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

test('portable sed: no BSD-only `sed -i \'\'` left, in-place helpers work and leave no backup file', () => {
  for (const file of ['deploy-full.sh', 'run.sh', 'lib/deploy-versions.sh']) {
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
  const files = ['run.sh', 'deploy-full.sh', 'lib/deploy-versions.sh'].map((f) => path.join(SCRIPTS_DIR, f));
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
