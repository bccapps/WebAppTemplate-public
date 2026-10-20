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
# update_common.sh — Sync the VXFramework libraries (vx-public + vx-private)
#
# Each library R is mounted twice (back/.libs/R and front/.libs/R: two checkouts of
# the same repo). For each R present in .gitmodules:
#   1. detached HEAD  -> checkout main
#   2. commit local changes of the BACK mount, fetch, rebase origin/main, push;
#      then the same for the FRONT mount (it rebases on what back just pushed)
#   3. both mounts end fast-forwarded on origin/main (same SHA, else error)
#   4. bump the refs in the parent repo (commit "chore: bump R")
# Then: .libs/apptemplate symlinks, root `scripts` symlink, CLAUDE.md/AGENTS.md,
# package.json regeneration (+ npm install).
#
# Usage:
#   ./scripts/update_common.sh              Normal sync (commit, pull/rebase, push, bump parent refs)
#   ./scripts/update_common.sh --push-only  Commit & push local changes + bump refs, skip pull
#   ./scripts/update_common.sh --pull-only  Pull only, skip commit/push & parent ref bump
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ---------- Colours ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}==> %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()   { printf "${RED}==> %s${NC}\n" "$*" >&2; }

# ---------- Args ----------
PUSH_ONLY=0
PULL_ONLY=0
for arg in "$@"; do
  case "${arg}" in
    --push-only) PUSH_ONLY=1 ;;
    --pull-only) PULL_ONLY=1 ;;
    *) err "unknown option: ${arg}"; exit 2 ;;
  esac
done
if [[ ${PUSH_ONLY} -eq 1 && ${PULL_ONLY} -eq 1 ]]; then
  err "--push-only and --pull-only are mutually exclusive"; exit 2
fi

REPOS=("vx-public" "vx-private")
DATE="$(date '+%Y-%m-%d %H:%M:%S')"
any_error=0

in_gitmodules() {
  [[ -f .gitmodules ]] && git config -f .gitmodules --get-regexp 'submodule\..*\.path' 2>/dev/null \
    | awk '{print $2}' | grep -qx "$1"
}
is_checkout() { [[ -d "$1/.git" || -f "$1/.git" ]]; }

# ---------- Legacy layout guard ----------
if in_gitmodules "back/.libs/nestcommon" || in_gitmodules "front/.libs/reactcommon" \
   || ! in_gitmodules "front/.libs/vx-public"; then
  err "This app still uses the legacy layout (nestcommon / reactcommon / apptemplate submodules)."
  err "Run scripts/migrate-to-webapptemplate.sh first."
  exit 1
fi

# ============================================================
# Per-mount operations
# ============================================================
ensure_main() {            # <name> <mount>
  local name="$1" mount="$2" branch
  branch="$(git -C "${mount}" branch --show-current 2>/dev/null || true)"
  if [[ "${branch}" != "main" ]]; then
    info "${name} (${mount}): switching to main..."
    git -C "${mount}" checkout main 2>/dev/null \
      || git -C "${mount}" checkout -b main origin/main 2>/dev/null \
      || { err "${name} (${mount}): could not switch to main"; return 1; }
  fi
}

# commit local changes, fetch, rebase on origin/main, push. Never forces.
sync_mount() {             # <name> <mount>
  local name="$1" mount="$2"
  if [[ ${PULL_ONLY} -eq 0 && -n "$(git -C "${mount}" status --porcelain)" ]]; then
    info "${name} (${mount}): committing local changes..."
    git -C "${mount}" add -A
    git -C "${mount}" commit -q -m "chore: update ${name} ${DATE}"
  fi
  if [[ ${PUSH_ONLY} -eq 0 ]]; then
    if ! git -C "${mount}" fetch -q origin; then
      warn "${name} (${mount}): fetch failed (no network?) — skipping pull"
    elif ! git -C "${mount}" merge -q --ff-only origin/main 2>/dev/null; then
      info "${name} (${mount}): fast-forward impossible — rebasing on origin/main..."
      if ! git -C "${mount}" rebase origin/main >/dev/null; then
        git -C "${mount}" rebase --abort 2>/dev/null || true
        err "${name} (${mount}): rebase conflict. Resolve manually in ${mount} (git rebase origin/main), then re-run. Nothing was forced."
        return 1
      fi
    fi
  fi
  if [[ ${PULL_ONLY} -eq 0 ]]; then
    if ! git -C "${mount}" push -q origin HEAD:main; then
      err "${name} (${mount}): push failed — check remote access or a non-fast-forward (re-run without --push-only)"
      return 1
    fi
  fi
}

sync_repo() {              # <name>  — back first, then front
  local name="$1" mount
  for mount in "back/.libs/${name}" "front/.libs/${name}"; do
    is_checkout "${mount}" || { warn "${name}: ${mount} not initialised — run: git submodule update --init"; return 0; }
  done
  for mount in "back/.libs/${name}" "front/.libs/${name}"; do
    ensure_main "${name}" "${mount}" || return 1
  done
  for mount in "back/.libs/${name}" "front/.libs/${name}"; do
    sync_mount "${name}" "${mount}" || return 1
  done
  if [[ ${PUSH_ONLY} -eq 0 ]]; then
    # Final alignment: both mounts fast-forward on origin/main and must agree.
    for mount in "back/.libs/${name}" "front/.libs/${name}"; do
      # Refresh the remote ref first: the second mount pushed on top of the first one, whose `origin/main`
      # would otherwise be stale (false "mounts differ" when both mounts had local changes).
      git -C "${mount}" fetch -q origin 2>/dev/null || true
      git -C "${mount}" merge -q --ff-only origin/main 2>/dev/null \
        || { err "${name} (${mount}): cannot fast-forward on origin/main (local unpushed commits?)"; return 1; }
    done
    local sha_back sha_front
    sha_back="$(git -C "back/.libs/${name}" rev-parse HEAD)"
    sha_front="$(git -C "front/.libs/${name}" rev-parse HEAD)"
    if [[ "${sha_back}" != "${sha_front}" ]]; then
      err "${name}: back (${sha_back:0:8}) and front (${sha_front:0:8}) mounts differ after sync."
      return 1
    fi
  fi
  ok "${name}: in sync"
}

bump_repo() {              # <name>
  local name="$1" paths=()
  for mount in "back/.libs/${name}" "front/.libs/${name}"; do
    git diff --quiet -- "${mount}" 2>/dev/null || paths+=("${mount}")
  done
  if (( ${#paths[@]} > 0 )); then
    git add "${paths[@]}"
    git commit -q -m "chore: bump ${name}"
    ok "${name}: refs bumped in the parent repo"
  fi
}

# ============================================================
# 1. Libraries
# ============================================================
for repo in "${REPOS[@]}"; do
  if ! in_gitmodules "back/.libs/${repo}" && ! in_gitmodules "front/.libs/${repo}"; then
    continue
  fi
  if ! sync_repo "${repo}"; then any_error=1; continue; fi
  if [[ ${PULL_ONLY} -eq 0 ]]; then bump_repo "${repo}"; fi
done

# ============================================================
# 2. Symlinks: <stack>/.libs/apptemplate -> vx-public/template, root scripts
# ============================================================
tracked_links=""
for stack in back front; do
  link="${stack}/.libs/apptemplate"
  if [[ -L "${link}" && "$(readlink "${link}")" == "vx-public/template" ]]; then continue; fi
  if [[ -e "${link}" && ! -L "${link}" ]]; then
    warn "${link} is a real file/directory — not overwriting"; continue
  fi
  rm -f "${link}"; ln -s vx-public/template "${link}"
  ok "symlink set: ${link} -> vx-public/template"
  tracked_links="${tracked_links} ${link}"
done
link="scripts"
desired="front/.libs/apptemplate/scripts"
if [[ -L "${link}" && "$(readlink "${link}")" != "${desired}" ]]; then
  rm "${link}"
fi
if [[ ! -e "${link}" && ! -L "${link}" ]]; then
  ln -s "${desired}" "${link}"; ok "symlink set: ${link} -> ${desired}"
  if git ls-files --error-unmatch "${link}" >/dev/null 2>&1; then tracked_links="${tracked_links} ${link}"; fi
fi
if [[ -n "${tracked_links}" ]]; then
  # shellcheck disable=SC2086
  git add -f ${tracked_links} 2>/dev/null || true
  if ! git diff --cached --quiet; then
    git commit -q -m "chore: fix apptemplate symlinks"
    ok "apptemplate symlinks committed"
  fi
fi

# Root CLAUDE.md = real file of @imports (+ project notes); AGENTS.md = generated, git-ignored.
if [[ -f back/.libs/apptemplate/scripts/project-docs.mjs ]]; then
  node back/.libs/apptemplate/scripts/project-docs.mjs ensure "${PROJECT_ROOT}"
  git add CLAUDE.md .gitignore 2>/dev/null || true
  if ! git diff --cached --quiet -- CLAUDE.md .gitignore; then
    git commit -q -m "chore: refresh CLAUDE.md imports" -- CLAUDE.md .gitignore
    ok "CLAUDE.md imports refreshed"
  fi
fi

# Pull new canonical common.* locale keys from the template into the app's own
# back/src/locales/common.{en,fr}.json (never overwrites a differing app value).
SYNC_LOCALES_SCRIPT="${PROJECT_ROOT}/back/.libs/apptemplate/scripts/sync-common-locales.mjs"
if [[ -f "${SYNC_LOCALES_SCRIPT}" && -f "${PROJECT_ROOT}/back/src/locales/common.en.json" ]]; then
  node "${SYNC_LOCALES_SCRIPT}" --root "${PROJECT_ROOT}"
  if ! git diff --quiet -- back/src/locales/common.en.json back/src/locales/common.fr.json 2>/dev/null; then
    git add back/src/locales/common.en.json back/src/locales/common.fr.json
    git commit -q -m "chore(deps): sync common locales from the template"
    ok "common locales: synced from the template"
  fi
fi

# ============================================================
# 3. Regenerate package.json (back + front) from package.base.json + fragments +
# package.local.json, and `npm install` if that changed anything. Runs
# unconditionally (including --pull-only): its point is making a pull take effect locally.
# ============================================================
regenerate_and_install() {
  local stack="$1"
  local dir="${PROJECT_ROOT}/${stack}"
  local build_script="${dir}/.libs/apptemplate/scripts/build-package.mjs"

  if [[ ! -f "${build_script}" || ! -f "${dir}/package.local.json" ]]; then
    return 0
  fi

  local before after
  before="$(cat "${dir}/package.json" 2>/dev/null || echo '')"
  if ! (cd "${dir}" && node "${build_script}" "${stack}"); then
    err "${stack}: package.json regeneration failed — check build-package.mjs output above"
    any_error=1
    return 0
  fi
  after="$(cat "${dir}/package.json" 2>/dev/null || echo '')"

  if [[ "${before}" == "${after}" ]]; then
    ok "${stack}: package.json unchanged"
    return 0
  fi

  info "${stack}: package.json changed after regeneration — running npm install..."
  if ! (cd "${dir}" && npm install); then
    err "${stack}: npm install failed — package.json was regenerated but dependencies are NOT installed. Resolve manually (peer-dependency conflict?) then re-run npm install."
    any_error=1
    return 0
  fi
  ok "${stack}: package.json regenerated + installed"

  if ! git diff --quiet -- "${stack}/package.json" "${stack}/package-lock.json" 2>/dev/null; then
    git add "${stack}/package.json" "${stack}/package-lock.json"
    git commit -q -m "chore(deps): regenerate ${stack}/package.json from the template"
    ok "${stack}: package.json/package-lock.json committed"
  fi
}

regenerate_and_install back
regenerate_and_install front

# ---------- Summary ----------
echo ""
if [[ ${any_error} -eq 1 ]]; then
  warn "Sync completed with errors — check output above"
  exit 1
else
  ok "Common libraries are in sync"
fi
