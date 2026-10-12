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
# Builds an ANONYMOUS project (no `user` module) from this repository in a
# temporary directory and checks that it compiles and that the back tests pass.
# It mimics what scripts/create-project.sh produces, with the libs vendored as
# real copies (not symlinks: Node resolves dependencies from the realpath of a
# file, so each stack needs its own copy under `.libs/vx-public`).
#
# Layout produced (same as an app that mounts this repo as `vx-public`):
#   <sandbox>/back/.libs/vx-public/{nest,react,template,tools}
#   <sandbox>/back/.libs/apptemplate -> vx-public/template   (relative symlink)
#   <sandbox>/front/.libs/...                                (same)
#
# Usage: tools/ci-sandbox.sh [sandbox-dir]   (default: a fresh mktemp directory)
# Env:   KEEP_SANDBOX=1 keeps an auto-created directory, SKIP_TESTS=1 skips back jest.
#        SANDBOX_PRIVATE=fake|<dir>  also mount a `vx-private` (a fake one with a single module
#                                    `fakemod` importing `common`, or a copy of <dir>/{nest,react})
#        SANDBOX_NEST / SANDBOX_REACT  comma lists of modules (default common,database,voice / common,voice;
#                                    with SANDBOX_PRIVATE=fake `fakemod` is appended)
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO=0
if [[ -z "${1:-}" ]]; then AUTO=1; SB="$(mktemp -d "${TMPDIR:-/tmp}/vx-ci-sandbox.XXXXXX")"; else SB="$1"; fi
mkdir -p "${SB}"
SB="$(cd "${SB}" && pwd)"
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# An auto-created sandbox is removed on success only (kept on failure for inspection).
cleanup() {
  local rc=$?
  if [[ "${AUTO}" == "1" && "${KEEP_SANDBOX:-0}" != "1" && "${rc}" == "0" ]]; then rm -rf "${SB}"; else echo "sandbox kept: ${SB}"; fi
}
trap cleanup EXIT

info "Sandbox: ${SB}"
PRIVATE_SRC=""
case "${SANDBOX_PRIVATE:-}" in
  "") ;;
  fake) PRIVATE_SRC="${SB}/.fake-private"; "${REPO}/tools/fake-private.sh" "${PRIVATE_SRC}" ;;
  *) PRIVATE_SRC="$(cd "${SANDBOX_PRIVATE}" && pwd)" ;;
esac
NEST_MODULES="${SANDBOX_NEST:-common,database,voice}"
REACT_MODULES="${SANDBOX_REACT:-common,voice}"
if [[ "${SANDBOX_PRIVATE:-}" == "fake" ]]; then NEST_MODULES+=",fakemod"; REACT_MODULES+=",fakemod"; fi

for stack in back front; do
  mkdir -p "${SB}/${stack}/src" "${SB}/${stack}/.libs/vx-public"
  rsync -a --exclude .git --exclude node_modules "${REPO}/template" "${REPO}/nest" "${REPO}/react" "${REPO}/tools" \
    "${SB}/${stack}/.libs/vx-public/"
  ln -sfn vx-public/template "${SB}/${stack}/.libs/apptemplate"
  if [[ -n "${PRIVATE_SRC}" ]]; then
    mkdir -p "${SB}/${stack}/.libs/vx-private"
    rsync -a --exclude .git --exclude node_modules "${PRIVATE_SRC}/nest" "${PRIVATE_SRC}/react" "${SB}/${stack}/.libs/vx-private/"
  fi
done

cd "${SB}"
ln -sfn front/.libs/apptemplate/scripts scripts
node -e '
  const list = (v) => v.split(",").filter(Boolean);
  require("fs").writeFileSync("shared-modules.json", JSON.stringify(
    { nestcommon: list(process.argv[1]), reactcommon: list(process.argv[2]) }, null, 2) + "\n");
' "${NEST_MODULES}" "${REACT_MODULES}"

info "Materializing config files and base components"
node scripts/link-config.mjs "${SB}"
node scripts/apply-component-templates.mjs "${SB}" \
  --site-name "CI Sandbox" --entity-name "CI Entity" \
  --contact-email "ci@example.com" --project-name "ci-sandbox"

printf '{ "name": "ci-sandbox-front", "version": "0.0.0", "scripts": { "build": "tsc -b && vite build" } }\n' > front/package.local.json
printf '{ "name": "ci-sandbox-back", "version": "0.0.0" }\n' > back/package.local.json

for stack in back front; do
  info "${stack}: build-package + npm install + build"
  ( cd "${stack}" \
    && node .libs/apptemplate/scripts/build-package.mjs "${stack}" \
    && npm install --no-audit --no-fund \
    && npm run build )
done

# Entity autoloading through the .libs symlinks, in the two modes: TypeScript sources
# (ts-node / TypeORM CLI: __dirname of the symlinked Datasource.ts is its REAL path) and
# the compiled build (dist/).
info "back: Datasource entity discovery (ts-node and dist)"
cat > back/ds-check.ts <<'TS'
import AppDataSource, { dbContext } from './src/config/Datasource';
(async () => {
  await AppDataSource.buildMetadatas();
  const names = AppDataSource.entityMetadatas.map((m) => m.name).sort();
  console.log(`baseDir=${dbContext.baseDir}\n${names.length} entities: ${names.join(', ')}`);
  const expected = ['ConfigurationEntity', ...(process.env.EXPECT_FAKE === '1' ? ['FakeEntity'] : [])];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) { console.error('MISSING: ' + missing.join(', ')); process.exit(1); }
})();
TS
export DB_HOST=localhost DB_PORT=5432 DB_USER=ci DB_PASSWORD=ci DB_NAME=ci EXPECT_FAKE=$([[ "${SANDBOX_PRIVATE:-}" == "fake" ]] && echo 1 || echo 0)
( cd back && npx ts-node --transpile-only -r tsconfig-paths/register ds-check.ts \
    && node -e "
      const m = require('./dist/config/Datasource');
      m.default.buildMetadatas().then(() => {
        const names = m.default.entityMetadatas.map((e) => e.name);
        console.log('dist baseDir=' + m.dbContext.baseDir + ', ' + names.length + ' entities');
        if (!names.includes('ConfigurationEntity') || (process.env.EXPECT_FAKE === '1' && !names.includes('FakeEntity'))) process.exit(1);
      });
    " )
rm -f back/ds-check.ts

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  info "back: jest"
  ( cd back && npx jest --maxWorkers=2 )
fi
info "CI sandbox OK"
