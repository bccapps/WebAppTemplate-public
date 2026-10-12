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
for stack in back front; do
  mkdir -p "${SB}/${stack}/src" "${SB}/${stack}/.libs/vx-public"
  rsync -a --exclude .git --exclude node_modules "${REPO}/template" "${REPO}/nest" "${REPO}/react" "${REPO}/tools" \
    "${SB}/${stack}/.libs/vx-public/"
  ln -sfn vx-public/template "${SB}/${stack}/.libs/apptemplate"
done

cd "${SB}"
ln -sfn front/.libs/apptemplate/scripts scripts
cat > shared-modules.json <<'JSON'
{
  "nestcommon": ["common", "database", "voice"],
  "reactcommon": ["common", "voice"]
}
JSON

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

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  info "back: jest"
  ( cd back && npx jest --maxWorkers=2 )
fi
info "CI sandbox OK"
