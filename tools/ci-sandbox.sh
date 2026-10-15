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
#   anonymous-sqlite  same as anonymous with the SQLite engine: DB_ENGINE=sqlite + DB_PATH in back/.env.dev,
#                better-sqlite3 in back/package.local.json, no Postgres variables; the entity discovery check
#                runs against a SQLite file
#   anonymous-sqlite-desktop  same as anonymous-sqlite with the desktop option: checks that desktop/, the workflow,
#                desktop.config.json and the desktop:* scripts are generated, and that build-desktop.mjs --dry-run
#                plans the resources. Rust is NOT compiled (no cargo, no tauri build): the .app build stays manual.
#   users-only   `user` WITHOUT `commerce` nor `infra` (no selling, no monitoring): proves that `user`
#                compiles and boots with its optional extension points absent. Same private library
#                options as multi-users.
#   multi-users  multi-user accounts + sales screens + voice, with a private library: by default
#                a fake one (tools/fake-private.sh --users: user, commerce, infra, tenant, fakemod, fakemulti, fakefactory
#                stand-ins); SANDBOX_PRIVATE=<dir> uses a copy of a real vx-private checkout
#                (dir containing nest/ and react/), e.g. the WebAppTemplate-private clone.
#
# Layout produced (same as an app that mounts this repo as `vx-public`):
#   <sandbox>/app/back/.libs/vx-public/{nest,react,template,tools}  (+ vx-private)
#   <sandbox>/app/back/.libs/apptemplate -> vx-public/template      (relative symlink)
#   <sandbox>/app/front/.libs/...                                   (same)
#
# Usage: tools/ci-sandbox.sh [anonymous|anonymous-sqlite|anonymous-sqlite-desktop|users-only|multi-users] [sandbox-dir]   (default dir: a fresh mktemp directory)
# Env:   KEEP_SANDBOX=1 keeps an auto-created directory, SKIP_TESTS=1 skips back jest,
#        SANDBOX_MODULES=a,b overrides the extra functional modules.
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="anonymous"
if [[ "${1:-}" == "anonymous" || "${1:-}" == "anonymous-sqlite" || "${1:-}" == "anonymous-sqlite-desktop" || "${1:-}" == "users-only" || "${1:-}" == "multi-users" ]]; then MODE="$1"; shift; fi
DB_ENGINE_ANSWER="selfhosted"
DESKTOP_ANSWER="false"
[[ "${MODE}" == "anonymous-sqlite" || "${MODE}" == "anonymous-sqlite-desktop" ]] && DB_ENGINE_ANSWER="sqlite"
[[ "${MODE}" == "anonymous-sqlite-desktop" ]] && DESKTOP_ANSWER="true"
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
if [[ "${MODE}" == "multi-users" || "${MODE}" == "users-only" ]]; then
  if [[ -n "${SANDBOX_PRIVATE:-}" ]]; then
    PRIVATE_SRC="$(cd "${SANDBOX_PRIVATE}" && pwd)"
    MODULES="${SANDBOX_MODULES:-voice,oauth}"
    [[ "${MODE}" == "users-only" ]] && MODULES="${SANDBOX_MODULES:-voice}"
    EXPECT_ENTITY="ConfigurationEntity,UserEntity"
  else
    PRIVATE_SRC="${SB}/.fake-private"
    "${REPO}/tools/fake-private.sh" "${PRIVATE_SRC}" --users
    MODULES="${SANDBOX_MODULES:-voice,fakemod,fakemulti,fakefactory}"
    EXPECT_ENTITY="ConfigurationEntity,FakeEntity"
  fi
  PRIVATE_ARGS=(--private-dir "${PRIVATE_SRC}")
  QUESTIONS='{"authMethods":["email"],"registration":"open","commerce":true}'
  [[ "${MODE}" == "users-only" ]] && QUESTIONS='{"authMethods":["email"],"registration":"open","commerce":false,"infra":false}'
  MODULES="${MODULES}" QUESTIONS="${QUESTIONS}" node -e '
    const modules = process.env.MODULES.split(",").filter(Boolean);
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      projectName: "app", siteName: "CI Sandbox", entityName: "CI Entity", contactEmail: "ci@example.com",
      privateAccess: true, multiUser: true, modules, languages: ["fr", "en"],
      questions: JSON.parse(process.env.QUESTIONS),
    }, null, 2));' "${ANSWERS}"
else
  MODULES="${SANDBOX_MODULES:-voice}"
  MODULES="${MODULES}" DB_ENGINE_ANSWER="${DB_ENGINE_ANSWER}" DESKTOP_ANSWER="${DESKTOP_ANSWER}" node -e '
    const modules = process.env.MODULES.split(",").filter(Boolean);
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      projectName: "app", siteName: "CI Sandbox", entityName: "CI Entity", contactEmail: "ci@example.com",
      privateAccess: false, multiUser: false, modules, languages: ["fr", "en"],
      database: { engine: process.env.DB_ENGINE_ANSWER, redis: false },
      desktop: { enabled: process.env.DESKTOP_ANSWER === "true", identifier: "com.example.ci-sandbox" },
    }, null, 2));' "${ANSWERS}"
fi

info "create-project.mjs --answers (${MODULES})"
node "${REPO}/template/scripts/create-project.mjs" --vendor-libs --no-install --no-github --no-commit \
  --public-dir "${REPO}" ${PRIVATE_ARGS[@]+"${PRIVATE_ARGS[@]}"} --answers "${ANSWERS}" --parent-dir "${SB}"
APP="${SB}/app"

# Plugin fixtures (fake private library): the factory plugin gets its options from the app's pluginOptions.ts.
if [[ "${MODULES}" == *fakefactory* ]]; then
  cat > "${APP}/back/src/config/pluginOptions.ts" <<'TS'
import type { PluginOptions } from 'src/modules_shared/common/plugins/NestModulePlugin';
export const pluginOptions: PluginOptions = { fakefactory: { label: 'ci' } };
TS
fi

if [[ "${MODE}" == "multi-users" || "${MODE}" == "users-only" ]]; then
  grep -q '"user"' "${APP}/shared-modules.json" || { echo "user module missing from shared-modules.json" >&2; exit 1; }
  if [[ "${MODE}" == "users-only" ]]; then
    for m in commerce infra; do
      if grep -q "\"${m}\"" "${APP}/shared-modules.json"; then echo "${m} must NOT be linked in users-only mode" >&2; exit 1; fi
    done
  fi
  if grep -q '^ADMIN_TOKEN=' "${APP}/back/.env.dev"; then echo "ADMIN_TOKEN must not be generated with user management" >&2; exit 1; fi
else
  grep -q '^ADMIN_TOKEN=[0-9a-f]\{64\}$' "${APP}/back/.env.dev" || { echo "ADMIN_TOKEN missing in anonymous mode" >&2; exit 1; }
fi

if [[ "${MODE}" == "anonymous-sqlite" || "${MODE}" == "anonymous-sqlite-desktop" ]]; then
  grep -q '^DB_ENGINE=sqlite$' "${APP}/back/.env.dev" || { echo "DB_ENGINE=sqlite missing in back/.env.dev" >&2; exit 1; }
  grep -q '^DB_PATH=data/app\.db$' "${APP}/back/.env.dev" || { echo "DB_PATH=data/app.db missing in back/.env.dev" >&2; exit 1; }
  if grep -qE '^(DB_HOST|DB_PASSWORD)=' "${APP}/back/.env.dev"; then echo "Postgres variables must not be generated with SQLite" >&2; exit 1; fi
  grep -q '"better-sqlite3"' "${APP}/back/package.local.json" || { echo "better-sqlite3 missing in back/package.local.json" >&2; exit 1; }
fi

if [[ "${MODE}" == "anonymous-sqlite-desktop" ]]; then
  info "desktop option: generated files (Rust is not compiled)"
  for f in desktop/desktop.config.json desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/tauri.conf.json desktop/splash/index.html .github/workflows/build-desktop.yml; do
    [[ -f "${APP}/${f}" ]] || { echo "${f} missing (desktop option)" >&2; exit 1; }
  done
  node -e '
    const read = (f) => JSON.parse(require("fs").readFileSync(process.argv[1] + "/" + f, "utf8"));
    const cfg = read("desktop/desktop.config.json");
    if (cfg.identifier !== "com.example.ci-sandbox" || cfg.productName !== "CI Sandbox") { console.error("desktop.config.json not filled: " + JSON.stringify(cfg)); process.exit(1); }
    const project = read("project.config.json").desktop;
    if (!project || project.enabled !== true || project.identifier !== cfg.identifier) { console.error("project.config.json desktop section wrong"); process.exit(1); }
    const scripts = read("back/package.json").scripts;
    if (!scripts["desktop:dev"] || !scripts["desktop:build"]) { console.error("desktop:* scripts missing in back/package.json"); process.exit(1); }
  ' "${APP}"
  ( cd "${APP}/desktop" && node --test scripts/*.test.mjs )
  # add-desktop must refuse a project that already has the shell
  if node "${REPO}/template/scripts/add-desktop.mjs" --root "${APP}" --dry-run; then echo "add-desktop must refuse an existing desktop option" >&2; exit 1; fi
else
  [[ -e "${APP}/desktop" || -e "${APP}/.github/workflows/build-desktop.yml" ]] && { echo "desktop files must not exist without the option" >&2; exit 1; }
fi

for stack in back front; do
  info "${stack}: npm install + build"
  ( cd "${APP}/${stack}" && npm install --no-audit --no-fund && npm run build )
done

if [[ "${MODE}" == "anonymous-sqlite-desktop" ]]; then
  info "desktop: resources plan (dry-run, nothing downloaded, nothing compiled)"
  node "${APP}/scripts/desktop/build-desktop.mjs" --root "${APP}" --dry-run
fi

if [[ "${MODE}" == "users-only" ]]; then
  for m in commerce infra; do
    if [[ -e "${APP}/back/src/modules_shared/${m}" ]]; then echo "${m} must be pruned from back/src/modules_shared" >&2; exit 1; fi
  done
  # The fake private library's `user` stand-in has no plugin.ts: only check the real one.
  if [[ -n "${SANDBOX_PRIVATE:-}" ]]; then
    grep -q "./user/plugin" "${APP}/back/src/modules_shared/plugins.generated.ts" || { echo "user plugin not wired" >&2; exit 1; }
  fi
fi

if [[ "${MODULES}" == *fakemulti* ]]; then
  # Multi-module plugin and options factory: wired by the generated file, resolved in order (fakemulti is early).
  info "back: plugin resolution (modules, order, factory options)"
  ( cd "${APP}/back" && node -e "
    require('reflect-metadata');
    const g = require('./dist/modules_shared/plugins.generated');
    const names = g.sharedPluginModules.map((m) => (m.module ?? m).name);
    const want = ['FakeMultiAModule', 'FakeMultiBModule', 'FakeMultiCModule'];
    if (names.slice(0, 3).join() !== want.join()) { console.error('plugin order/modules wrong: ' + names); process.exit(1); }
    const dyn = g.sharedPluginModules.find((m) => m.module && m.module.name === 'FakeFactoryModule');
    if (!dyn || dyn.providers[0].useValue !== 'ci') { console.error('factory options not applied'); process.exit(1); }
    console.log('plugins OK: ' + names.join(', '));
  " )
fi

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
if [[ "${MODE}" == "anonymous-sqlite" || "${MODE}" == "anonymous-sqlite-desktop" ]]; then
  export DB_ENGINE=sqlite DB_PATH="${SB}/ci.db" EXPECT_ENTITIES="${EXPECT_ENTITY}"
else
  export DB_HOST=localhost DB_PORT=5432 DB_USER=ci DB_PASSWORD=ci DB_NAME=ci EXPECT_ENTITIES="${EXPECT_ENTITY}"
fi
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
