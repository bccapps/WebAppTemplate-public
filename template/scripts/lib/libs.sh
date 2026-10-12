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
# Shared shell helpers to mount the VXFramework libraries in an app.
# Meant to be SOURCED by create-project.sh and migrate-to-webapptemplate.sh
# (and by create-project.mjs through `bash -c`).
#
# Layout produced (per stack, back and front):
#   <stack>/.libs/vx-public    submodule  (WebAppTemplate-public, MIT)
#   <stack>/.libs/vx-private   submodule  (WebAppTemplate-private) — optional
#   <stack>/.libs/apptemplate  committed symlink -> vx-public/template
#
# Env: VX_PUBLIC_URL, VX_PRIVATE_URL, LIB_BRANCH (default main).
# Callers must define info/warn/ok.
# =============================================================================

VX_PUBLIC_URL="${VX_PUBLIC_URL:-https://github.com/bccapps/WebAppTemplate-public.git}"
VX_PRIVATE_URL="${VX_PRIVATE_URL:-https://github.com/bccapps/WebAppTemplate-private.git}"
LIB_BRANCH="${LIB_BRANCH:-main}"

# True when <path> is declared as a submodule in the .gitmodules of the cwd repo.
vx_submodule_declared() {
  [[ -f .gitmodules ]] || return 1
  git config -f .gitmodules --get-regexp 'submodule\..*\.path' 2>/dev/null \
    | awk '{print $2}' | grep -qx "$1"
}

# vx_add_submodule <path> <url>   (idempotent)
vx_add_submodule() {
  local submodule_path="$1" url="$2"
  if vx_submodule_declared "${submodule_path}"; then
    ok "submodule '${submodule_path}' already declared."
  elif [[ -e "${submodule_path}" ]]; then
    warn "'${submodule_path}' exists but is not a declared submodule — check manually, skipped."
  else
    git submodule add -b "${LIB_BRANCH}" "${url}" "${submodule_path}"
    ok "submodule '${submodule_path}' added."
  fi
}

# vx_link_symlink <target> <linkpath>   (idempotent, never overwrites a real file)
vx_link_symlink() {
  local target="$1" linkpath="$2"
  if [[ -L "${linkpath}" ]]; then
    ok "symlink '${linkpath}' already present."
  elif [[ -e "${linkpath}" ]]; then
    warn "'${linkpath}' exists and is not a symlink — check manually, skipped."
  else
    mkdir -p "$(dirname "${linkpath}")"
    ln -s "${target}" "${linkpath}"
    ok "symlink '${linkpath}' -> '${target}' created."
  fi
}

# vx_setup_libs <with_private 0|1>
# Run from the project root (a git repo). Mounts vx-public (+ vx-private) in back and
# front and creates the .libs/apptemplate symlinks.
vx_setup_libs() {
  local with_private="${1:-0}" stack
  for stack in back front; do
    vx_add_submodule "${stack}/.libs/vx-public" "${VX_PUBLIC_URL}"
    if [[ "${with_private}" == "1" ]]; then
      vx_add_submodule "${stack}/.libs/vx-private" "${VX_PRIVATE_URL}"
    fi
  done
  git submodule update --init
  for stack in back front; do
    vx_link_symlink vx-public/template "${stack}/.libs/apptemplate"
  done
  ok "Libraries mounted: vx-public$([[ "${with_private}" == "1" ]] && echo ', vx-private') (x2 mounts) + .libs/apptemplate symlinks."
}

# vx_link_root_pointers   — root `scripts` symlink (CLAUDE.md / AGENTS.md: see project-docs.mjs)
vx_link_root_pointers() {
  vx_link_symlink front/.libs/apptemplate/scripts scripts
}

# When executed (not sourced): `libs.sh setup <with_private 0|1>` — used by create-project.mjs.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m⚠\033[0m  %s\n' "$*" >&2; }
  ok()   { printf '\033[1;32m✓\033[0m  %s\n' "$*"; }
  case "${1:-}" in
    setup) set -euo pipefail; vx_setup_libs "${2:-0}"; vx_link_root_pointers ;;
    *) echo "usage: libs.sh setup <with_private 0|1>" >&2; exit 2 ;;
  esac
fi
