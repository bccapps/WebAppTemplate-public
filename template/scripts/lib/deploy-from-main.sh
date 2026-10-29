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
# DEPLOY_FROM_MAIN=true of deploy-full.sh: ships the commit of origin/main from a clean temporary clone, NEVER from the
# project working copy. That copy is shared by several sessions (agents, the user): it is never checked out, stashed or
# switched, and none of its uncommitted or untracked files reach the build (decision 2026-10-29, after a deploy that
# switched it to main copied an agent's untracked files into the build and lost an edit made meanwhile).
# SOURCED by deploy-full.sh only when the option is on (bash 3.2 compatible), once back/.env is loaded and the logging
# (info/warn/err/success), deploy-timing.sh, deploy-versions.sh and db-engine.sh helpers exist.
# Entry point: dfm_run "$@" — never returns, exits with the exit code of the deploy (0, 1, 3, 4…).
#
#   1. `git fetch origin main` in the project (only refs/remotes/origin/main moves, no FETCH_HEAD written);
#   2. `git clone --shared --no-checkout` of the project into $TMPDIR (objects borrowed: nothing copied, nothing written
#      into the project's .git), origin/main checked out detached, every submodule at the commit main records (cloned
#      from the project's URL for it, --reference to the project's own checkout: only missing objects are downloaded),
#      nested ones included; the tree must then be exactly that commit (git status empty, submodules clean);
#   3. what git does not hold and the deploy reads is copied in (dfm_copy_local_inputs), the modules_shared links are
#      created, node_modules provided (dfm_provide_node_modules) and ./backups linked to the project's (dfm_link_backups);
#   4. the tree's own scripts/deploy-full.sh — the version main records, consistent with that commit's compose files,
#      Dockerfiles and libraries — runs from the tree as a child with DEPLOY_FROM_MAIN off, DEPLOY_FROM_MAIN_TREE set (no
#      second clone), DEPLOY_LIBS_SYNCED=1 (libraries stay at main's commits), DEPLOY_REVISION = main's short sha (unless
#      already set) and the staged env files;
#   5. an EXIT trap removes the tree once the child has ended: success, failure, rollback, Ctrl-C (SIGTERM / SIGHUP are
#      acted on when the child stops: the tree is never removed under a running deploy). KEEP_BUILD_CONTEXT=1 keeps it.
#
#   DEPLOY_FROM_MAIN_COPY="a b/c"  extra paths (relative to the project, files or folders) that git does not hold and
#                                  the build needs, copied over main's version into the tree.
# =============================================================================

DFM_TREE=""        # temporary clone of the repository (removed at exit)
DFM_ROOT=""        # the project inside DFM_TREE (= DFM_TREE unless the project is a sub-folder of its repository)
DFM_SHA=""         # commit of origin/main being deployed
DFM_BACK_ENV=""    # BACK_ENV_FILE / FRONT_ENV_FILE handed to the deploy run in the tree
DFM_FRONT_ENV=""
DFM_COPIED=()      # paths copied from the working copy into the tree (only their names are logged)

# EXIT trap of dfm_run. rm -rf never follows a link: the node_modules and backups links into the project are removed,
# not what they point to.
dfm_cleanup() {
  local tree="${DFM_TREE}"
  DFM_TREE=""
  [[ -n "${tree}" && -d "${tree}" ]] || return 0
  if [[ "${KEEP_BUILD_CONTEXT:-0}" == "1" ]]; then
    warn "KEEP_BUILD_CONTEXT=1: the clean tree of main stays at ${tree} (rm -rf it when done)"
    return 0
  fi
  rm -rf "${tree}" || warn "Could not remove the temporary tree ${tree} — remove it by hand"
}

# True for a path relative to the project that stays inside it (not absolute, no `~`, no `..` component).
dfm_inner_path() {
  local p="$1"
  [[ -n "${p}" && "${p}" != /* && "${p}" != "~"* && "/${p}/" != *"/../"* ]]
}

# 1. Fetches origin/main (DFM_SHA); only refs/remotes/origin/main moves (no FETCH_HEAD: another session may be using
# its own). Warns when the local main holds commits origin/main lacks: they are not deployed.
dfm_fetch_main() {
  local top="$1" ahead
  git -C "${top}" fetch --quiet --no-write-fetch-head origin main \
    || { err "DEPLOY_FROM_MAIN=true: could not fetch origin/main — nothing was deployed."; return 1; }
  DFM_SHA="$(git -C "${top}" rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}')" \
    || { err "DEPLOY_FROM_MAIN=true: no origin/main after the fetch — nothing was deployed."; return 1; }
  ahead="$(git -C "${top}" rev-list --count "${DFM_SHA}..refs/heads/main" 2>/dev/null || echo 0)"
  if [[ "${ahead}" != "0" ]]; then
    warn "Local branch main has ${ahead} commit(s) that origin/main does not have: NOT deployed (push main to ship them)."
  fi
}

# 2. Clean clone of the repository at DFM_SHA with its submodules (DFM_TREE, DFM_ROOT). <prefix> = the project's
# folder inside its repository (`git rev-parse --show-prefix`, empty at the top).
dfm_clone_tree() {
  local top="$1" prefix="$2" common url key path name ref
  local -a refopt
  DFM_TREE="$(mktemp -d "${TMPDIR:-/tmp}/${PROJECT_NAME:-app}-main.XXXXXX")" \
    || { err "Could not create a temporary directory for the clean tree."; return 1; }
  DFM_ROOT="${DFM_TREE}${prefix:+/${prefix%/}}"
  # Cloned from the common git directory: also right when the project is itself a linked worktree.
  common="$(cd "${top}" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" \
    || { err "Could not locate the git directory of ${top}."; return 1; }
  git clone --quiet --shared --no-checkout "${common}" "${DFM_TREE}" \
    || { err "Could not clone ${top} into ${DFM_TREE}."; return 1; }
  # Relative submodule URLs resolve against `origin`, as in the project (not against the project's path).
  url="$(git -C "${top}" remote get-url origin 2>/dev/null || true)"
  if [[ -n "${url}" ]]; then
    git -C "${DFM_TREE}" remote set-url origin "${url}" || return 1
  fi
  git -C "${DFM_TREE}" -c advice.detachedHead=false checkout --quiet --detach "${DFM_SHA}" \
    || { err "Could not check out ${DFM_SHA} in the clean tree."; return 1; }
  while read -r key path; do
    [[ -n "${path}" ]] || continue
    name="${key#submodule.}"
    name="${name%.path}"
    # The project's own URL for it (it may differ from .gitmodules: ssh instead of https, a mirror), in the tree's config.
    url="$(git -C "${top}" config --get "submodule.${name}.url" 2>/dev/null || true)"
    if [[ -n "${url}" ]]; then
      git -C "${DFM_TREE}" config "submodule.${name}.url" "${url}" || return 1
    fi
    refopt=()
    if [[ -e "${top}/${path}/.git" ]]; then
      ref="$(git -C "${top}/${path}" rev-parse --absolute-git-dir 2>/dev/null || true)"
      if [[ -n "${ref}" ]]; then refopt=(--reference "${ref}"); fi
    fi
    git -C "${DFM_TREE}" submodule update --init --quiet ${refopt[@]+"${refopt[@]}"} -- "${path}" </dev/null \
      || { err "Could not check out the submodule ${path} at the commit main records."; return 1; }
  done < <(git -C "${DFM_TREE}" config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)
  # Nested submodules (and any the loop above did not list).
  git -C "${DFM_TREE}" submodule update --init --recursive --quiet </dev/null \
    || { err "Could not check out the nested submodules of main."; return 1; }
}

# The tree is exactly DFM_SHA: no change, no untracked file, every submodule (nested too) at the recorded commit.
dfm_assert_exact_tree() {
  local subs dirty
  subs="$(git -C "${DFM_TREE}" submodule status --recursive 2>&1 | grep -v '^ ' || true)"
  dirty="$(git -C "${DFM_TREE}" status --porcelain --ignore-submodules=none 2>&1 || echo 'git status failed')"
  if [[ -n "${subs}" || -n "${dirty}" ]]; then
    err "The clean tree is not exactly origin/main ${DFM_SHA}:"
    printf '%s\n%s\n' "${subs}" "${dirty}" | sed -e '/^$/d' -e 's/^/    /' >&2
    return 1
  fi
}

# Copies <rel> (relative to the project; file or folder) from the working copy into the tree. Without <overwrite>=1
# only when main has nothing at that path: a file main tracks wins.
dfm_copy_in() {
  local rel="$1" overwrite="${2:-0}" src dst
  src="${PROJECT_ROOT}/${rel}"
  dst="${DFM_ROOT}/${rel}"
  [[ -e "${src}" ]] || return 0
  if [[ -e "${dst}" || -L "${dst}" ]]; then
    [[ "${overwrite}" == "1" ]] || return 0
    [[ -d "${dst}" && ! -L "${dst}" ]] || rm -f "${dst}"
  fi
  mkdir -p "$(dirname "${dst}")" || return 1
  if [[ -d "${src}" ]]; then
    mkdir -p "${dst}" && cp -pR "${src}/." "${dst}/" || return 1
  else
    cp -p "${src}" "${dst}" || return 1
  fi
  DFM_COPIED+=("${rel}")
}

# BACK_ENV_FILE / FRONT_ENV_FILE of the deploy run in the tree (DFM_BACK_ENV, DFM_FRONT_ENV), always the working copy's
# version. A path inside the project keeps its place in the tree. The back env (sourced by that deploy, uploaded as the
# remote .env) loses its DEPLOY_FROM_MAIN line: the inner deploy must never start another clean tree — and a
# deploy-full.sh older than this file would switch branches. Outside the project (absolute, `..`): the back env becomes
# back/<its name> in the tree (the name gives the environment, .env = prod), the front env is read where it is.
dfm_stage_env_files() {
  local rel src dst
  rel="${BACK_ENV_FILE#./}"
  if dfm_inner_path "${rel}"; then
    src="${PROJECT_ROOT}/${rel}"
    DFM_BACK_ENV="./${rel}"
  else
    src="${BACK_ENV_FILE}"
    [[ "${src}" == /* ]] || src="${PROJECT_ROOT}/${src}"
    DFM_BACK_ENV="./back/$(basename "${BACK_ENV_FILE}")"
  fi
  dst="${DFM_ROOT}/${DFM_BACK_ENV#./}"
  mkdir -p "$(dirname "${dst}")" || return 1
  rm -f "${dst}"
  # grep exits 1 when no line is left (a file holding only that line): not an error.
  (umask 077 && grep -Ev '^[[:space:]]*(export[[:space:]]+)?DEPLOY_FROM_MAIN[[:space:]]*=' "${src}" > "${dst}") \
    || [[ $? -eq 1 ]] || { err "Could not copy ${BACK_ENV_FILE} into the clean tree."; return 1; }
  DFM_COPIED+=("${DFM_BACK_ENV#./} (without DEPLOY_FROM_MAIN)")

  rel="${FRONT_ENV_FILE#./}"
  if dfm_inner_path "${rel}"; then
    dfm_copy_in "${rel}" 1 || return 1
    DFM_FRONT_ENV="./${rel}"
  else
    DFM_FRONT_ENV="${FRONT_ENV_FILE}"
    [[ "${DFM_FRONT_ENV}" == /* ]] || DFM_FRONT_ENV="${PROJECT_ROOT}/${DFM_FRONT_ENV}"
  fi
}

# 3a. What the deploy reads and git does not hold (git-ignored): every back/.env* and front/.env* (deploy env files,
# back/.env.preprod for the cross-env DB keys, the front/.env.<mode> files Vite loads), back/<DB_SSLROOTCERT>, SSH keys
# kept inside the project, local back/*.tgz packages, then DEPLOY_FROM_MAIN_COPY. Never a source file: an untracked
# file of the working copy is exactly what must not reach a deploy of main.
dfm_copy_local_inputs() {
  local f rel var
  DFM_COPIED=()
  dfm_stage_env_files || return 1
  for f in "${PROJECT_ROOT}"/back/.env* "${PROJECT_ROOT}"/front/.env* "${PROJECT_ROOT}"/back/*.tgz; do
    [[ -f "${f}" ]] || continue
    dfm_copy_in "${f#"${PROJECT_ROOT}"/}" || return 1
  done
  rel="${DB_SSLROOTCERT:-}"
  rel="${rel#./}"
  if dfm_inner_path "${rel}"; then
    dfm_copy_in "back/${rel}" || return 1
  fi
  for var in SSH_KEY_FILE BACK_SSH_KEY_FILE FRONT_SSH_KEY_FILE; do
    rel="${!var:-}"
    rel="${rel#./}"
    if dfm_inner_path "${rel}" && [[ -f "${PROJECT_ROOT}/${rel}" ]]; then
      dfm_copy_in "${rel}" || return 1
    fi
  done
  # shellcheck disable=SC2086 # a space-separated list of paths
  for rel in ${DEPLOY_FROM_MAIN_COPY:-}; do
    rel="${rel#./}"
    dfm_inner_path "${rel}" || { err "DEPLOY_FROM_MAIN_COPY: '${rel}' is not a path inside the project."; return 1; }
    if [[ ! -e "${PROJECT_ROOT}/${rel}" ]]; then
      warn "DEPLOY_FROM_MAIN_COPY: ${rel} not found in the working copy — skipped"
      continue
    fi
    dfm_copy_in "${rel}" 1 || return 1
  done
}

# 3b. src/modules_shared is git-ignored (symlinks made by link-shared.mjs at install/prebuild); the deploy stages the
# stacks BEFORE building them, so the links must exist in the tree from the start.
dfm_link_shared_modules() {
  local stack
  for stack in back front; do
    [[ -f "${DFM_ROOT}/${stack}/.libs/apptemplate/scripts/link-shared.mjs" ]] || continue
    (cd "${DFM_ROOT}/${stack}" && node .libs/apptemplate/scripts/link-shared.mjs "${stack}" >/dev/null) \
      || { err "Could not link the shared modules of ${stack} in the clean tree."; return 1; }
  done
}

# 3c. node_modules of <stack> in the tree. When main's package.json (regenerated as the deploy does) and package-lock.json
# are byte-identical to the working copy's, and its node_modules was installed from that lock (npm's
# node_modules/.package-lock.json not older than package-lock.json): a real directory of links to the working copy's
# packages and .bin — node_modules itself is not linked, so the caches the build writes there (tsc's .tmp, .vite) stay
# in the tree — plus the install stamp computed by main's own stack_install_hash, so main's deploy-full.sh skips
# `npm install` (which would write through the links). Otherwise nothing: the deploy installs main's lock into the tree
# (`npm install`, as on a fresh clone).
dfm_provide_node_modules() {
  local stack="$1" src dst script why="" nm stamp
  src="${PROJECT_ROOT}/${stack}"
  dst="${DFM_ROOT}/${stack}"
  script="${DFM_ROOT}/scripts/deploy-full.sh"
  [[ -d "${dst}" && ! -e "${dst}/node_modules" ]] || return 0
  if [[ "${DEPLOY_NPM_INSTALL:-auto}" == "always" ]]; then
    why="DEPLOY_NPM_INSTALL=always"
  elif ! grep -q '^stack_install_hash() {$' "${script}" || ! grep -q 'node_modules/\.vx-deploy-install' "${script}"; then
    why="main's deploy-full.sh has no install stamp"
  elif [[ ! -f "${src}/node_modules/.package-lock.json" || ! -f "${src}/package-lock.json" ]]; then
    why="no npm-installed node_modules in the working copy"
  elif [[ "${src}/package-lock.json" -nt "${src}/node_modules/.package-lock.json" ]]; then
    why="the working copy's package-lock.json changed since its last install"
  elif [[ -f "${dst}/.libs/apptemplate/scripts/build-package.mjs" ]] \
    && ! (cd "${dst}" && node .libs/apptemplate/scripts/build-package.mjs "${stack}" >/dev/null); then
    why="package.json regeneration failed"
  elif ! cmp -s "${src}/package-lock.json" "${dst}/package-lock.json"; then
    why="main's package-lock.json differs from the working copy's"
  elif ! cmp -s "${src}/package.json" "${dst}/package.json"; then
    why="main's package.json differs from the working copy's"
  fi
  if [[ -n "${why}" ]]; then
    info "[main] ${stack}: npm install into the clean tree (${why})"
    return 0
  fi
  if nm="$(cd "${src}/node_modules" && pwd -P)" && mkdir "${dst}/node_modules" \
    && ln -s "${nm}"/* "${nm}/.package-lock.json" "${dst}/node_modules/" \
    && { [[ ! -e "${nm}/.bin" ]] || ln -s "${nm}/.bin" "${dst}/node_modules/.bin"; } \
    && stamp="$(eval "$(sed -n '/^stack_install_hash() {$/,/^}$/p' "${script}")"; stack_install_hash "${dst}")" \
    && [[ -n "${stamp}" ]] && printf '%s\n' "${stamp}" > "${dst}/node_modules/.vx-deploy-install"; then
    info "[main] ${stack}: same package.json and package-lock.json as the working copy — its node_modules is reused (links, no install)"
    return 0
  fi
  rm -rf "${dst}/node_modules"
  warn "[main] ${stack}: could not reuse the working copy's node_modules — npm install into the clean tree"
}

# 3d. The local copies of the database backups (./backups/deploy-<env>/, lib/deploy-versions.sh) must outlive the tree,
# and the deploy must see the copies already there (age and count rules): ./backups of the tree links to the project's.
# Only for an engine that has them (SQLite, self-hosted Postgres) and when the back is deployed.
dfm_link_backups() {
  local rel
  [[ "${DEPLOY_DB_BACKUP_DOWNLOAD:-1}" != "0" && "${DEPLOY_TARGET:-all}" != "front" ]] || return 0
  [[ "${IS_SQLITE_DB:-0}" -eq 1 || "${IS_SELF_HOSTED_DB:-0}" -eq 1 ]] || return 0
  rel="$(dv_local_backup_dir)"
  rel="${rel#./}"
  rel="${rel%%/*}"
  if [[ -e "${DFM_ROOT}/${rel}" || -L "${DFM_ROOT}/${rel}" ]]; then
    warn "main tracks ${rel}/: the local database backup copies of this deploy stay in the temporary tree"
    return 0
  fi
  mkdir -p "${PROJECT_ROOT}/${rel}" || return 1
  ln -s "$(cd "${PROJECT_ROOT}/${rel}" && pwd -P)" "${DFM_ROOT}/${rel}"
}

# Deploys origin/main from a clean temporary clone (steps above); exits with the deploy's exit code.
dfm_run() {
  local top prefix branch short subject t0 timings rc=0 tree_script stack
  top="$(git -C "${PROJECT_ROOT}" rev-parse --show-toplevel 2>/dev/null)" \
    || { err "DEPLOY_FROM_MAIN=true: ${PROJECT_ROOT} is not a git working copy — aborting."; exit 1; }
  prefix="$(git -C "${PROJECT_ROOT}" rev-parse --show-prefix)"
  branch="$(git -C "${top}" branch --show-current 2>/dev/null || true)"
  trap dfm_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  info "DEPLOY_FROM_MAIN=true: deploying origin/main from a clean temporary clone — the working copy (${top}, ${branch:-detached HEAD}) is not touched"

  t0="$(dt_now)"
  dfm_fetch_main "${top}" || exit 1
  timings="main: fetch origin/main=$(( $(dt_now) - t0 ))"
  short="$(git -C "${top}" rev-parse --short "${DFM_SHA}")"
  subject="$(git -C "${top}" log -1 --format=%s "${DFM_SHA}")"
  info "[main] Deploying origin/main ${short} — ${subject}"

  t0="$(dt_now)"
  dfm_clone_tree "${top}" "${prefix}" || exit 1
  dfm_assert_exact_tree || exit 1
  timings="${timings};main: clean clone + submodules=$(( $(dt_now) - t0 ))"
  info "[main] Clean tree ${DFM_TREE} = origin/main ${short}, submodules at the commits main records:"
  git -C "${DFM_TREE}" submodule status --recursive | sed 's/^/    /'
  tree_script="${DFM_ROOT}/scripts/deploy-full.sh"
  [[ -f "${tree_script}" ]] || { err "main has no scripts/deploy-full.sh — nothing was deployed."; exit 1; }
  if ! cmp -s "${tree_script}" "${SCRIPT_DIR}/deploy-full.sh"; then
    warn "[main] main records another deploy-full.sh than the one launched: the deploy runs main's (publish main to deploy with newer scripts)"
  fi

  t0="$(dt_now)"
  dfm_copy_local_inputs || exit 1
  if [[ ${#DFM_COPIED[@]} -gt 0 ]]; then
    info "[main] Copied from the working copy (not in git): ${DFM_COPIED[*]}"
  fi
  dfm_link_shared_modules || exit 1
  resolve_db_engine
  dfm_link_backups || exit 1
  for stack in back front; do
    dfm_provide_node_modules "${stack}" || { err "Could not prepare ${stack}/node_modules in the clean tree."; exit 1; }
  done
  timings="${timings};main: local inputs + node_modules=$(( $(dt_now) - t0 ))"

  (
    cd "${DFM_ROOT}" || exit 1
    DEPLOY_FROM_MAIN=0 DEPLOY_FROM_MAIN_TREE="${DFM_TREE}" DEPLOY_LIBS_SYNCED=1 \
    DEPLOY_REVISION="${DEPLOY_REVISION:-${short}}" BACK_ENV_FILE="${DFM_BACK_ENV}" FRONT_ENV_FILE="${DFM_FRONT_ENV}" \
    DEPLOY_STARTED_AT="${DT_STARTED_AT}" DEPLOY_TIMINGS="${DEPLOY_TIMINGS:+${DEPLOY_TIMINGS};}${timings}" \
      exec "${tree_script}" "$@"
  ) || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    success "DEPLOY_FROM_MAIN=true: origin/main ${short} deployed — the working copy (${branch:-detached HEAD}) was not touched"
  else
    warn "DEPLOY_FROM_MAIN=true: the deploy of origin/main ${short} ended with exit ${rc} — the working copy (${branch:-detached HEAD}) was not touched"
  fi
  exit "${rc}"
}
