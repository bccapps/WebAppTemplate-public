#!/usr/bin/env bash
# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================
#
# Builds a project from this repository in a temporary directory with the project wizard
# (template/scripts/create-project.mjs, non-interactive, libraries vendored as real copies:
# Node resolves dependencies from the realpath of a file, so each stack needs its own copy
# under `.libs/vx-public`), then checks that back and front compile, that TypeORM finds the
# entities of the linked modules, and that the back tests pass.
#
# Modes:
#   anonymous    (default) common + database + voice, no `user`: admin protected by ADMIN_TOKEN
#   multi-users  multi-user accounts + sales screens + voice, with a private library: by default
#                a fake one (tools/fake-private.sh --users: user, commerce, infra, tenant, fakemod
#                stand-ins); SANDBOX_PRIVATE=<dir> uses a copy of a real vx-private checkout
#                (dir containing nest/ and react/), e.g. the WebAppTemplate-private clone.
#
# Layout produced (same as an app that mounts this repo as `vx-public`):
#   <sandbox>/app/back/.libs/vx-public/{nest,react,template,tools}  (+ vx-private)
#   <sandbox>/app/back/.libs/apptemplate -> vx-public/template      (relative symlink)
#   <sandbox>/app/front/.libs/...                                   (same)
#
# Usage: tools/ci-sandbox.sh [anonymous|multi-users] [sandbox-dir]   (default dir: a fresh mktemp directory)
# Env:   KEEP_SANDBOX=1 keeps an auto-created directory, SKIP_TESTS=1 skips back jest,
#        SANDBOX_MODULES=a,b overrides the extra functional modules.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="anonymous"
if [[ "${1:-}" == "anonymous" || "${1:-}" == "multi-users" ]]; then MODE="$1"; shift; fi
AUTO=0
if [[ -z "${1:-}" ]]; then AUTO=1; SB="$(mktemp -d "${TMPDIR:-/tmp}/vx-ci-sandbox.XXXXXX")"; else SB="$1"; fi
mkdir -p "${SB}"
SB="$(cd "${SB}" && pwd)"
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com

# An auto-created sandbox is removed on success only (kept on failure for inspection).
cleanup() {
  local rc=$?
  if [[ "${AUTO}" == "1" && "${KEEP_SANDBOX:-0}" != "1" && "${rc}" == "0" ]]; then rm -rf "${SB}"; else echo "sandbox kept: ${SB}"; fi
}
trap cleanup EXIT

info "Sandbox (${MODE}): ${SB}"
ANSWERS="${SB}/answers.json"
PRIVATE_ARGS=()
EXPECT_ENTITY="ConfigurationEntity"
if [[ "${MODE}" == "multi-users" ]]; then
  if [[ -n "${SANDBOX_PRIVATE:-}" ]]; then
    PRIVATE_SRC="$(cd "${SANDBOX_PRIVATE}" && pwd)"
    MODULES="${SANDBOX_MODULES:-voice,oauth}"
  else
    PRIVATE_SRC="${SB}/.fake-private"
    "${REPO}/tools/fake-private.sh" "${PRIVATE_SRC}" --users
    MODULES="${SANDBOX_MODULES:-voice,fakemod}"
    EXPECT_ENTITY="ConfigurationEntity,FakeEntity"
  fi
  PRIVATE_ARGS=(--private-dir "${PRIVATE_SRC}")
  MODULES="${MODULES}" node -e '
    const modules = process.env.MODULES.split(",").filter(Boolean);
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      projectName: "app", siteName: "CI Sandbox", entityName: "CI Entity", contactEmail: "ci@example.com",
      privateAccess: true, multiUser: true, modules, languages: ["fr", "en"],
      questions: { authMethods: ["email"], registration: "open", commerce: true },
    }, null, 2));' "${ANSWERS}"
else
  MODULES="${SANDBOX_MODULES:-voice}"
  MODULES="${MODULES}" node -e '
    const modules = process.env.MODULES.split(",").filter(Boolean);
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      projectName: "app", siteName: "CI Sandbox", entityName: "CI Entity", contactEmail: "ci@example.com",
      privateAccess: false, multiUser: false, modules, languages: ["fr", "en"],
    }, null, 2));' "${ANSWERS}"
fi

info "create-project.mjs --answers (${MODULES})"
node "${REPO}/template/scripts/create-project.mjs" --vendor-libs --no-install --no-github --no-commit \
  --public-dir "${REPO}" ${PRIVATE_ARGS[@]+"${PRIVATE_ARGS[@]}"} --answers "${ANSWERS}" --parent-dir "${SB}"
APP="${SB}/app"

if [[ "${MODE}" == "multi-users" ]]; then
  grep -q '"user"' "${APP}/shared-modules.json" || { echo "user module missing from shared-modules.json" >&2; exit 1; }
  if grep -q '^ADMIN_TOKEN=' "${APP}/back/.env.dev"; then echo "ADMIN_TOKEN must not be generated with user management" >&2; exit 1; fi
else
  grep -q '^ADMIN_TOKEN=[0-9a-f]\{64\}$' "${APP}/back/.env.dev" || { echo "ADMIN_TOKEN missing in anonymous mode" >&2; exit 1; }
fi

for stack in back front; do
  info "${stack}: npm install + build"
  ( cd "${APP}/${stack}" && npm install --no-audit --no-fund && npm run build )
done

# Entity autoloading through the .libs symlinks, in the two modes: TypeScript sources
# (ts-node / TypeORM CLI: __dirname of the symlinked Datasource.ts is its REAL path) and
# the compiled build (dist/).
info "back: Datasource entity discovery (ts-node and dist)"
cat > "${APP}/back/ds-check.ts" <<'TS'
import AppDataSource, { dbContext } from './src/config/Datasource';
(async () => {
  await AppDataSource.buildMetadatas();
  const names = AppDataSource.entityMetadatas.map((m) => m.name).sort();
  console.log(`baseDir=${dbContext.baseDir}\n${names.length} entities: ${names.join(', ')}`);
  const missing = (process.env.EXPECT_ENTITIES ?? '').split(',').filter((n) => n && !names.includes(n));
  if (missing.length) { console.error('MISSING: ' + missing.join(', ')); process.exit(1); }
})();
TS
export DB_HOST=localhost DB_PORT=5432 DB_USER=ci DB_PASSWORD=ci DB_NAME=ci EXPECT_ENTITIES="${EXPECT_ENTITY}"
( cd "${APP}/back" && npx ts-node --transpile-only -r tsconfig-paths/register ds-check.ts \
    && node -e "
      const m = require('./dist/config/Datasource');
      m.default.buildMetadatas().then(() => {
        const names = m.default.entityMetadatas.map((e) => e.name);
        console.log('dist baseDir=' + m.dbContext.baseDir + ', ' + names.length + ' entities');
        const missing = process.env.EXPECT_ENTITIES.split(',').filter((n) => n && !names.includes(n));
        if (missing.length) { console.error('MISSING (dist): ' + missing.join(', ')); process.exit(1); }
      });
    " )
rm -f "${APP}/back/ds-check.ts"

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  info "back: jest"
  ( cd "${APP}/back" && npx jest --maxWorkers=2 )
fi
info "CI sandbox (${MODE}) OK"
