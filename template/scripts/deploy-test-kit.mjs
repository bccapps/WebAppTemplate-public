/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Shared harness of the deploy tests (deploy-versions.test.mjs, deploy-registry.test.mjs): STUB executables (docker, ssh, scp, rsync,
// git, npm...) put first on PATH and a throw-away project wired to the real template scripts. Nothing ever reaches a real host.
// Every stub appends its argv to $STUB_LOG; image tags are files in $STUB_STATE (content = fake image id).

import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BACK_PROJECT = 'testapp-back-10-0-0-1'; // compose project name of the back host 10.0.0.1
export const FRONT_PROJECT = 'testapp-front-10-0-0-2';

export const STUBS = {
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
  build) while [ $# -gt 0 ]; do if [ "$1" = --tag ] || [ "$1" = -t ]; then echo built > "$(img "$2")"; fi; shift; done; cat > /dev/null ;;
  buildx) while [ $# -gt 0 ]; do if [ "$1" = -t ]; then echo built > "$(img "$2")"; fi; shift; done ;;
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
      config)
        # the staged compose project as \`docker compose config --format json\` prints it (env_file values inlined = secrets)
        printf '{"services":{"back":{"build":{"context":"%s/back","dockerfile":"Dockerfile","args":{"APP_RUNTIME_DIR":"shared"}},"image":"testapp_back:latest","environment":{"JWT_SECRET":"s3cret-do-not-keep"}},"back-worker":{"image":"testapp_back:latest"},"front":{"build":{"context":"%s/front","dockerfile":"Dockerfile","args":{"NODE_PORT":"9741"}}},"voice-engine":{"profiles":["voice"],"build":{"context":"%s/voice-engine"}},"db":{"image":"postgres:17-alpine"}}}' "$dir" "$dir" "$dir" \
          | { if [ -n "\${STUB_WORKER_BUILD:-}" ]; then sed 's#"back-worker":{"image":"testapp_back:latest"}#"back-worker":{"image":"testapp_worker:latest","build":{"context":"/tmp/worker","dockerfile":"Dockerfile.worker"}}#'; else cat; fi; }
        ;;
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
  # registry mode: the host's own docker (login, pull, push, digest) run through ssh
  *"docker pull '"*)
    if [ -n "\${STUB_PULL_FAIL:-}" ]; then exit 1; fi
    q="'"; ref="\${cmd#*docker pull $q}"; ref="\${ref%$q}"
    echo "new" > "$STUB_STATE/img_$(printf '%s' "$ref" | tr '/:' '__')" ;;
  *"docker push '"*) if [ -n "\${STUB_PUSH_FAIL:-}" ]; then exit 1; fi ;;
  *RepoDigests*) echo "registry.example.com/testapp/back@sha256:\${STUB_DIGEST:-deadbeef}" ;;
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
  // local client tools: backup-db.sh dumps a cloud database from the deploying machine
  pg_dump: '#!/usr/bin/env bash\necho "pg_dump $*" >> "$STUB_LOG"\nif [ -n "${STUB_PGDUMP_FAIL:-}" ]; then exit 1; fi\necho "-- pg dump"\n',
  psql: '#!/usr/bin/env bash\necho "psql $*" >> "$STUB_LOG"\nexit 0\n',
  npm: '#!/usr/bin/env bash\necho "npm $*" >> "$STUB_LOG"\nexit 0\n',
  npx: '#!/usr/bin/env bash\necho "npx $*" >> "$STUB_LOG"\nexit 0\n',
  curl: '#!/usr/bin/env bash\necho "curl $*" >> "$STUB_LOG"\nexit 0\n',
  envsubst: '#!/usr/bin/env bash\ncat\n',
  sleep: '#!/usr/bin/env bash\nexit 0\n',
};

export function write(file, content, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

/** A throw-away project (symlinked template scripts, stub binaries, stub state) + a runner for run.sh. */
export function makeProject({ engine = 'sqlite', extraBackEnv = '' } = {}) {
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

