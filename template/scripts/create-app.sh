#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

set -euo pipefail

# ============================================================
# create-app.sh — initialise the desktop application (Tauri shell) in an existing project
# ============================================================
# Usage:
#   ./scripts/create-app.sh [--name "Product Name"] [--identifier com.example.app] [--config <desktop.config.json sample>] [--dry-run]
#
# Wraps scripts/add-desktop.mjs: copies desktop/ and the build-desktop workflow, fills desktop/desktop.config.json, adds the
# desktop:dev / desktop:build scripts. Defaults:
#   identifier   cc.web3c.<PROJECT_NAME>  (PROJECT_NAME of back/.env, else back/.env.dev); it names the OS data folder of the app
#   name         productName of the config sample when there is one, else PROJECT_NAME
#   config       docs/desktop/desktop.config.<PROJECT_NAME>.json when present: copied over the generated desktop.config.json
#                (its identifier is always replaced by the one above, so the identifier rule holds; its productName only by --name)
# A desktop/ folder holding only build/ (staging left by earlier runs of app.sh) is kept aside and put back. Nothing else is overwritten.
# Then: ./scripts/app.sh (needs Node >= 22 and Rust, https://rustup.rs).
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()   { printf "${GREEN}==> %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()  { printf "${RED}==> %s${NC}\n" "$*" >&2; exit 1; }

NAME=""; NAME_GIVEN=""; IDENTIFIER=""; CONFIG=""; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) [[ $# -ge 2 ]] || err "--name needs a value"; NAME="$2"; NAME_GIVEN=force-name; shift 2 ;;
    --identifier) [[ $# -ge 2 ]] || err "--identifier needs a value"; IDENTIFIER="$2"; shift 2 ;;
    --config) [[ $# -ge 2 ]] || err "--config needs a value"; CONFIG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "Unknown option: $1" ;;
  esac
done

command -v node >/dev/null || err "node not found (Node.js >= 22 required)"

# PROJECT_NAME: back/.env, else back/.env.dev (last assignment wins, quotes stripped, nothing evaluated).
read_project_name() {
  local file value
  for file in back/.env back/.env.dev; do
    [[ -f "${file}" ]] || continue
    value="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PROJECT_NAME=//p' "${file}" | tail -n 1 | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//")"
    if [[ -n "${value}" ]]; then printf '%s' "${value}"; return 0; fi
  done
  return 1
}

PROJECT_NAME_VALUE="$(read_project_name || true)"
if [[ -z "${IDENTIFIER}" ]]; then
  [[ -n "${PROJECT_NAME_VALUE}" ]] || err "PROJECT_NAME not found in back/.env or back/.env.dev: pass --identifier"
  # A reverse-domain segment: letters, digits, hyphens (the OS refuses anything else).
  SEGMENT="$(printf '%s' "${PROJECT_NAME_VALUE}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n-' '-')"
  IDENTIFIER="cc.web3c.${SEGMENT}"
fi
[[ -n "${CONFIG}" || -z "${PROJECT_NAME_VALUE}" ]] || {
  candidate="docs/desktop/desktop.config.${PROJECT_NAME_VALUE}.json"
  [[ -f "${candidate}" ]] && CONFIG="${candidate}"
}
[[ -z "${CONFIG}" || -f "${CONFIG}" ]] || err "Config sample not found: ${CONFIG}"
if [[ -z "${NAME}" && -n "${CONFIG}" ]]; then
  NAME="$(node -e "const n = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).productName; if (n) process.stdout.write(String(n))" "${CONFIG}")"
fi
[[ -n "${NAME}" ]] || NAME="${PROJECT_NAME_VALUE:-${IDENTIFIER##*.}}"

if [[ -f desktop/desktop.config.json ]]; then
  err "The desktop shell is already initialised (desktop/desktop.config.json exists). Launch it with ./scripts/app.sh"
fi

# The shell hands the built front to the back through SERVE_FRONT_DIR: a back/src/main.ts that never calls serveFrontend answers
# "Cannot GET /" (404) in the app. Say so before installing rather than after the first launch.
if [[ -f back/src/main.ts ]] && ! grep -q 'serveFrontend' back/src/main.ts; then
  warn "back/src/main.ts does not call serveFrontend(): the app would show 'Cannot GET /'. Add, before app.init():"
  warn "  const frontDir = resolveFrontDir(); if (frontDir) serveFrontend(app, frontDir);   (both from modules_shared/common/bootstrap; see the template main.ts)"
  warn "and, after app.listen(), exitWhenParentGone() so the back stops with the shell."
fi

info "Desktop app:\"${NAME}\" (${IDENTIFIER})${CONFIG:+, config ${CONFIG}}"

ARGS=(--yes --name "${NAME}" --identifier "${IDENTIFIER}")
[[ ${DRY_RUN} -eq 1 ]] && ARGS+=(--dry-run)

# desktop/ holding only build/ is a leftover of the variant staging: set it aside so add-desktop.mjs sees a clean slate.
ASIDE=""
restore_build() {
  if [[ -n "${ASIDE}" && -d "${ASIDE}/build" ]]; then
    mkdir -p desktop
    rm -rf desktop/build
    mv "${ASIDE}/build" desktop/build
    rmdir "${ASIDE}" 2>/dev/null || true
  fi
}
if [[ -d desktop && "$(ls -A desktop)" == "build" ]]; then
  ASIDE="$(mktemp -d "${TMPDIR:-/tmp}/vx-create-app.XXXXXX")"
  mv desktop/build "${ASIDE}/build"
  rmdir desktop
  trap restore_build EXIT
fi

node scripts/add-desktop.mjs "${ARGS[@]}" || err "add-desktop.mjs failed (see above)"

if [[ ${DRY_RUN} -eq 0 && -n "${CONFIG}" ]]; then
  node -e "
    const fs = require('fs');
    const [sample, name, identifier] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(sample, 'utf8'));
    if (process.argv[4] === 'force-name') c.productName = name;
    c.identifier = identifier;
    fs.writeFileSync('desktop/desktop.config.json', JSON.stringify(c, null, 2) + '\n');
  " "${CONFIG}" "${NAME}" "${IDENTIFIER}" "${NAME_GIVEN}"
  ok "desktop/desktop.config.json written from ${CONFIG}"
fi

if [[ ${DRY_RUN} -eq 0 ]]; then
  command -v cargo >/dev/null || warn "cargo not found: install Rust with rustup (https://rustup.rs) before ./scripts/app.sh"
  ok "Desktop app initialised. Build and launch it with ./scripts/app.sh"
fi
