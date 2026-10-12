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
# update_common.sh — Sync shared libraries (nestcommon + reactcommon)
#
# 1. For each submodule: commit & push local changes (if any)
# 2. Pull latest upstream commits into both submodules
# 3. Commit updated submodule refs in the parent repo (if changed)
#
# Usage:
#   ./scripts/update_common.sh           Normal sync (commit, pull/rebase, push, bump parent refs)
#   ./scripts/update_common.sh --push-only  Commit & push local changes + bump parent refs, skip pull
#   ./scripts/update_common.sh --pull-only  Pull only, skip push & parent ref bump
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
  esac
done

# ---------- Submodule map: label → path ----------
SUBMODULE_NAMES=("nestcommon" "reactcommon")

get_submodule_path() {
  case "$1" in
    nestcommon)  echo "back/.libs/nestcommon" ;;
    reactcommon) echo "front/.libs/reactcommon" ;;
  esac
}

DATE="$(date '+%Y-%m-%d %H:%M:%S')"
any_error=0

# ============================================================
# STEP -1 — AppTemplate (HOMOGENEOUS: edited in .libs/apptemplate and pushed, just
# like nestcommon/reactcommon). The repo is mounted twice (front + back) — we treat
# front/.libs/apptemplate as the canonical working tree (commit + push), then sync
# the back mount and the symlinked clone (APPTEMPLATE_DIR, used to RUN ./scripts/*).
# SCRIPT_DIR resolves to the clone's scripts/ dir because scripts/ is a symlink.
# ============================================================
APPTEMPLATE_DIR="$(dirname "${SCRIPT_DIR}")"
AT_CANONICAL="front/.libs/apptemplate"
AT_MIRROR="back/.libs/apptemplate"
AT_FULL="${PROJECT_ROOT}/${AT_CANONICAL}"

if [[ -d "${AT_FULL}/.git" || -f "${AT_FULL}/.git" ]]; then
  # Submodules default to detached HEAD; a tracked branch is needed to push.
  at_branch="$(git -C "${AT_FULL}" branch --show-current 2>/dev/null || true)"
  if [[ "${at_branch}" != "main" ]]; then
    info "apptemplate: ${AT_CANONICAL} detached — switching to main..."
    git -C "${AT_FULL}" checkout main 2>/dev/null || \
      git -C "${AT_FULL}" checkout -b main origin/main 2>/dev/null || \
      warn "apptemplate: could not switch to main — operations may fail"
  fi

  # STEP 1 — commit local changes (homogeneous with nestcommon/reactcommon)
  if [[ ${PULL_ONLY} -eq 0 && -n "$(git -C "${AT_FULL}" status --porcelain 2>/dev/null)" ]]; then
    info "apptemplate: committing local changes in ${AT_CANONICAL}..."
    git -C "${AT_FULL}" add -A
    git -C "${AT_FULL}" commit -m "chore: update app-template ${DATE}"
  fi

  # STEP 2 — sync with upstream, then push
  if [[ ${PUSH_ONLY} -eq 0 ]] && git -C "${AT_FULL}" fetch origin 2>/dev/null; then
    git -C "${AT_FULL}" merge --ff-only origin/main 2>/dev/null || \
      git -C "${AT_FULL}" rebase origin/main 2>/dev/null || \
      warn "apptemplate: could not fast-forward/rebase onto origin/main — resolve manually"
  fi
  if [[ ${PULL_ONLY} -eq 0 ]]; then
    if git -C "${AT_FULL}" push origin HEAD:main 2>/dev/null; then
      ok "apptemplate: pushed"
    else
      warn "apptemplate: nothing to push (or no write access)"
    fi
  fi
fi

# Mirror the back mount (second checkout of the same repo) to upstream.
MIR_FULL="${PROJECT_ROOT}/${AT_MIRROR}"
if [[ -d "${MIR_FULL}/.git" || -f "${MIR_FULL}/.git" ]]; then
  git -C "${MIR_FULL}" checkout -- . 2>/dev/null || true
  git -C "${MIR_FULL}" clean -fd 2>/dev/null || true
  git -C "${PROJECT_ROOT}" submodule update --remote "${AT_MIRROR}" 2>/dev/null || \
    warn "apptemplate: back mirror sync failed"
fi

# Ensure root-level symlinks (scripts/, CLAUDE.md) point at the canonical submodule
# working tree so edits in .libs/ are immediately visible without a push/pull cycle.
# If a symlink is tracked in git, record it so it gets included in the bump commit.
root_links_changed=""
for root_link in "scripts" "CLAUDE.md"; do
  link_path="${PROJECT_ROOT}/${root_link}"
  desired="${AT_CANONICAL}/${root_link}"   # relative from PROJECT_ROOT = symlink parent
  if [[ -L "${link_path}" ]]; then
    current="$(readlink "${link_path}")"
    [[ "${current}" == "${desired}" ]] && continue
    rm "${link_path}"
  elif [[ -e "${link_path}" ]]; then
    warn "apptemplate: ${root_link} is a real file/dir — not overwriting"
    continue
  fi
  ln -sf "${desired}" "${link_path}"
  ok "apptemplate: root symlink set: ${root_link} → ${desired}"
  # If git tracks this file, stage it for the bump commit
  if git -C "${PROJECT_ROOT}" ls-files --error-unmatch "${root_link}" >/dev/null 2>&1; then
    root_links_changed="${root_links_changed} ${root_link}"
  fi
done

# Record updated apptemplate submodule refs (and any redirected root symlinks) in the parent.
at_refs_changed="${root_links_changed}"
for at_path in "${AT_CANONICAL}" "${AT_MIRROR}"; do
  git -C "${PROJECT_ROOT}" diff --quiet -- "${at_path}" 2>/dev/null || at_refs_changed="${at_refs_changed} ${at_path}"
done
if [[ -n "${at_refs_changed}" ]]; then
  # shellcheck disable=SC2086
  git -C "${PROJECT_ROOT}" add ${at_refs_changed}
  if git -C "${PROJECT_ROOT}" diff --cached --quiet; then
    ok "apptemplate: parent refs already current"
  else
    git -C "${PROJECT_ROOT}" commit -m "chore(deps): bump app-template submodule(s)"
    ok "apptemplate submodule refs committed"
  fi
fi

# Pull any new canonical common.* locale keys from AppTemplate into this app's own
# back/src/locales/common.{en,fr}.json (never overwrites a differing app value — see
# sync-common-locales.mjs). Runs after the apptemplate refresh above so it sees the latest.
SYNC_LOCALES_SCRIPT="${AT_FULL}/scripts/sync-common-locales.mjs"
if [[ -f "${SYNC_LOCALES_SCRIPT}" && -f "${PROJECT_ROOT}/back/src/locales/common.en.json" ]]; then
  node "${SYNC_LOCALES_SCRIPT}" --root "${PROJECT_ROOT}"
  if ! git -C "${PROJECT_ROOT}" diff --quiet -- back/src/locales/common.en.json back/src/locales/common.fr.json 2>/dev/null; then
    git -C "${PROJECT_ROOT}" add back/src/locales/common.en.json back/src/locales/common.fr.json
    git -C "${PROJECT_ROOT}" commit -m "chore(deps): sync common locales from app-template"
    ok "common locales: synced from app-template"
  fi
fi

# ============================================================
# STEP 0 — Ensure each submodule is on the main branch
# (submodules are normally checked out in detached HEAD state;
#  bare `git push` fails without a tracked branch)
# ============================================================
for name in "${SUBMODULE_NAMES[@]}"; do
  path="$(get_submodule_path "${name}")"
  if [[ ! -d "${PROJECT_ROOT}/${path}/.git" && ! -f "${PROJECT_ROOT}/${path}/.git" ]]; then
    continue
  fi
  current_branch="$(git -C "${PROJECT_ROOT}/${path}" branch --show-current 2>/dev/null || true)"
  if [[ -z "${current_branch}" || "${current_branch}" != "main" ]]; then
    info "${name}: detached HEAD — switching to main branch..."
    git -C "${PROJECT_ROOT}/${path}" checkout main 2>/dev/null || \
      git -C "${PROJECT_ROOT}/${path}" checkout -b main origin/main 2>/dev/null || \
      warn "${name}: could not switch to main — operations may fail"
  fi
done

# ============================================================
# STEP 1 — Commit & push local changes in each submodule
# ============================================================
if [[ ${PULL_ONLY} -eq 0 ]]; then
  for name in "${SUBMODULE_NAMES[@]}"; do
    path="$(get_submodule_path "${name}")"

    # Skip if submodule not initialised
    if [[ ! -d "${PROJECT_ROOT}/${path}/.git" && ! -f "${PROJECT_ROOT}/${path}/.git" ]]; then
      warn "${name}: not initialised — run: git submodule update --init"
      continue
    fi

    info "${name}: checking for local changes..."

    # Collect untracked + modified files
    local_changes="$(git -C "${PROJECT_ROOT}/${path}" status --porcelain 2>/dev/null || true)"

    if [[ -z "${local_changes}" ]]; then
      ok "${name}: nothing to commit"
      continue
    fi

    info "${name}: staging all changes..."
    git -C "${PROJECT_ROOT}/${path}" add -A

    info "${name}: committing..."
    git -C "${PROJECT_ROOT}/${path}" commit -m "chore: update common ${DATE}"
    ok "${name}: committed (will push after upstream sync)"
  done
fi

# ============================================================
# STEP 2 — Sync submodules with upstream, then push
#   --push-only : skips the fetch/ff-rebase (pull) but STILL pushes local commits.
#   --pull-only : skips this whole block (no push, no parent ref bump).
#   The push lives OUTSIDE the pull guard on purpose — putting it inside meant
#   --push-only never actually pushed (and never bumped the parent refs).
# ============================================================
if [[ ${PULL_ONLY} -eq 0 ]]; then
  for name in "${SUBMODULE_NAMES[@]}"; do
    path="$(get_submodule_path "${name}")"

    if [[ ! -d "${PROJECT_ROOT}/${path}/.git" && ! -f "${PROJECT_ROOT}/${path}/.git" ]]; then
      continue
    fi

    # ---- Pull (fetch + fast-forward/rebase) — skipped in --push-only mode ----
    if [[ ${PUSH_ONLY} -eq 0 ]]; then
      info "${name}: fetching upstream..."
      if git -C "${PROJECT_ROOT}/${path}" fetch origin 2>/dev/null; then
        if git -C "${PROJECT_ROOT}/${path}" merge --ff-only origin/main 2>/dev/null; then
          ok "${name}: fast-forwarded to origin/main"
        else
          warn "${name}: fast-forward not possible — trying rebase..."
          if git -C "${PROJECT_ROOT}/${path}" rebase origin/main; then
            ok "${name}: rebased successfully"
          else
            err "${name}: rebase failed — resolve conflicts in ${path}"
            git -C "${PROJECT_ROOT}/${path}" rebase --abort 2>/dev/null || true
            any_error=1
            continue
          fi
        fi
      else
        warn "${name}: fetch failed (no network?) — skipping pull"
      fi
    fi

    # ---- Push (always attempted unless --pull-only) ----
    info "${name}: pushing..."
    if git -C "${PROJECT_ROOT}/${path}" push origin HEAD:main 2>/dev/null; then
      ok "${name}: pushed"
    else
      err "${name}: push failed — check remote access (HTTPS credentials / write permission) or a non-fast-forward (re-run without --push-only to sync first)"
      any_error=1
    fi
  done

  # ============================================================
  # STEP 3 — Commit updated submodule refs in the parent repo
  # ============================================================
  changed_refs=""
  for name in "${SUBMODULE_NAMES[@]}"; do
    path="$(get_submodule_path "${name}")"
    if ! git diff --quiet -- "${path}" 2>/dev/null; then
      changed_refs="${changed_refs} ${path}"
    fi
  done

  if [[ -n "${changed_refs}" ]]; then
    info "Updating submodule refs in parent repo..."
    # shellcheck disable=SC2086
    git add ${changed_refs}
    git commit -m "chore(deps): update nestcommon + reactcommon submodule refs"
    ok "Parent repo submodule refs committed"
  else
    ok "Parent repo submodule refs are already up-to-date"
  fi
fi

# ============================================================
# STEP 4 — Regenerate package.json (back + front) from package.base.json
# (just synced above) + package.local.json, and `npm install` if that
# changed anything. Without this, a dependency added to package.base.json
# only lands in the submodule checkout — the CONSUMING app's own
# package.json/node_modules stay stale until this runs, which silently
# breaks its build even though `update_common.sh` reported success.
# Runs unconditionally (including --pull-only) since its whole point is
# making a pull actually take effect locally; skipped per-stack if that
# stack doesn't use the package.base.json/package.local.json system.
# Real incident (2026-09-15): a project ran update_common.sh and still hit
# "Cannot find module '@base-org/account/node'" — this step didn't exist yet.
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

  if ! git -C "${PROJECT_ROOT}" diff --quiet -- "${stack}/package.json" "${stack}/package-lock.json" 2>/dev/null; then
    git -C "${PROJECT_ROOT}" add "${stack}/package.json" "${stack}/package-lock.json"
    git -C "${PROJECT_ROOT}" commit -m "chore(deps): regenerate ${stack}/package.json from app-template"
    ok "${stack}: package.json/package-lock.json committed"
  fi

  warn "${stack}: if the new dependency uses a subpath export (pkg/subpath) and moduleResolution is \"node\", you may still need to add a tsconfig.json \"paths\" entry by hand — see CLAUDE.md \"package.json is a GENERATED file\" section."
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
