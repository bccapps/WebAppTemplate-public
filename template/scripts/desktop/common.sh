#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

# Steps shared by scripts/app.sh and scripts/bundle.sh (sourced, not executed). The caller sets PROJECT_ROOT and
# `cd`s into it. Everything project-specific stays in desktop/desktop.config.json and in the optional prepare hook.

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()   { printf "${GREEN}==> %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()  { printf "${RED}==> %s${NC}\n" "$*" >&2; }

DESKTOP_SCRIPTS="${PROJECT_ROOT}/scripts/desktop"

# Target id of this machine, same naming as scripts/desktop/lib.mjs (darwin-arm64, linux-x64, win-x64...).
host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW*|MSYS*|CYGWIN*) os=win ;;
    *) err "Unsupported OS: $(uname -s)"; return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) err "Unsupported CPU: $(uname -m)"; return 1 ;;
  esac
  echo "${os}-${arch}"
}

desktop_check_project() {
  [[ -f desktop/desktop.config.json ]] || { err "No desktop/desktop.config.json: add the shell with node scripts/add-desktop.mjs"; return 1; }
  command -v node >/dev/null || { err "node not found (Node.js >= 22 required)"; return 1; }
  command -v cargo >/dev/null || { err "cargo not found: install Rust with rustup (https://rustup.rs)"; return 1; }
}

# `field <expr>` reads desktop/desktop.config.json with node (expr receives `c`, the parsed config).
desktop_field() {
  node -e "const c = JSON.parse(require('fs').readFileSync('desktop/desktop.config.json', 'utf8')); console.log($1)"
}

# npm ci in <dir> when node_modules is missing (an existing install is the developer's business).
ensure_node_modules() {
  local dir="$1"
  [[ -d "${dir}/node_modules" ]] && return 0
  info "Installing ${dir} dependencies (npm ci)"
  (cd "${dir}" && npm ci)
}

# Desktop VARIANT (project.config.json: desktop.variant, or a desktop-flavor.json descriptor at the root; see
# scripts/desktop/variant.mjs): prints the variant's module list file when the project has one, nothing otherwise.
desktop_variant() {
  node "${DESKTOP_SCRIPTS}/variant.mjs" describe --root "${PROJECT_ROOT}"
}

# Where back/dist and front/dist of the desktop app are built: the project, or the isolated stage of its variant.
build_root() {
  if [[ -n "$(desktop_variant)" ]]; then echo "${PROJECT_ROOT}/desktop/build/variant"; else echo "${PROJECT_ROOT}"; fi
}

# Builds back/dist and front/dist, and the desktop tooling (@tauri-apps/cli). With a desktop variant the back and the front
# are built from an isolated copy with the variant's module set (the developer's tree is left untouched).
build_web() {
  ensure_node_modules desktop
  if [[ -n "$(desktop_variant)" ]]; then
    info "Staging and building the desktop variant ($(desktop_variant))"
    node "${DESKTOP_SCRIPTS}/variant.mjs" stage --root "${PROJECT_ROOT}" ${DESKTOP_CLEAN:+--clean}
    return 0
  fi
  ensure_node_modules back
  ensure_node_modules front
  info "Building the back (nest build)"
  (cd back && npm run build)
  info "Building the front"
  (cd front && npm run build)
}

# Runs the project's prepare hook for <target>, when present and executable: it builds what
# packaging.extraResources copies (e.g. an embedded Python engine). Contract: scripts-local/desktop-prepare.sh <target>,
# run from the project root; DESKTOP_CLEAN=1 asks for a full rebuild; a non-zero exit stops the build of that target.
run_prepare_hook() {
  local target="$1"
  local hook="${DESKTOP_PREPARE_HOOK:-./scripts-local/desktop-prepare.sh}"
  if [[ -x "${hook}" ]]; then
    info "Prepare hook for ${target} (${hook})"
    "${hook}" "${target}"
  elif [[ -e "${hook}" ]]; then
    err "${hook} exists but is not executable (chmod +x)"; return 1
  fi
}

# Resources folder of a target (one per target, so switching targets never reuses another platform's node_modules).
resources_dir() { echo "${PROJECT_ROOT}/desktop/build/resources-$1"; }

# build-desktop.mjs for <target> into its resources folder, plus the extra arguments. The production node_modules
# are reinstalled only when back/package-lock.json changed since the last assembly of that target (or DESKTOP_CLEAN=1).
assemble() {
  local target="$1"; shift
  local out; out="$(resources_dir "${target}")"
  local skip=()
  local lock; lock="$(build_root)/back/package-lock.json"
  if [[ "${DESKTOP_CLEAN:-0}" != 1 && -d "${out}/back/node_modules" ]] && cmp -s "${lock}" "${out}/back/package-lock.json"; then
    skip=(--skip-install)
  fi
  node "${DESKTOP_SCRIPTS}/build-desktop.mjs" --root "${PROJECT_ROOT}" --target "${target}" --out "${out}" ${skip[@]+"${skip[@]}"} "$@"
}

# Folder of Tauri's release build and of its bundles.
release_dir() { echo "${PROJECT_ROOT}/desktop/src-tauri/target/release"; }
