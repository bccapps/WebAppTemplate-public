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
# Exercises the git side of the library mechanism with LOCAL bare "origins" (no network,
# no npm install): create-project.sh (submodules + symlinks), update_common.sh in
# --pull-only and in push mode, deploy-full staging semantics (rsync -aL on the
# .libs/apptemplate symlink). The origins are snapshots of this working tree, so
# uncommitted changes are tested too.
#
# Usage: tools/ci-git-flow.sh [workdir]      (default: a fresh mktemp dir, removed on success)
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO=0
if [[ -z "${1:-}" ]]; then AUTO=1; WD="$(mktemp -d "${TMPDIR:-/tmp}/vx-git-flow.XXXXXX")"; else WD="$1"; fi
mkdir -p "${WD}"; WD="$(cd "${WD}" && pwd)"
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
cleanup() { local rc=$?; if [[ "${AUTO}" == "1" && "${rc}" == "0" ]]; then rm -rf "${WD}"; else echo "workdir kept: ${WD}"; fi; }
trap cleanup EXIT

export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com

# snapshot_origin <name> <file-listing-cmd...> : bare repo whose main = snapshot of cwd files
make_origin() {
  local name="$1" src="$2" snap="${WD}/snap-$1"
  mkdir -p "${snap}"
  ( cd "${src}" && rsync -a --exclude .git --exclude node_modules ./ "${snap}/" )
  ( cd "${snap}" && git init -q -b main && git add -A && git commit -q -m "snapshot ${name}" )
  git init -q --bare -b main "${WD}/origins/${name}.git"
  ( cd "${snap}" && git push -q "${WD}/origins/${name}.git" main )
}

mkdir -p "${WD}/origins"
"${REPO}/tools/fake-private.sh" "${WD}/fake-private"
make_origin public "${REPO}"
make_origin private "${WD}/fake-private"
export VX_PUBLIC_URL="${WD}/origins/public.git" VX_PRIVATE_URL="${WD}/origins/private.git"
export VX_SKIP_INSTALL=1 VX_SKIP_GITHUB=1

info "create-project.sh --with-private"
mkdir -p "${WD}/proj"
printf '\n\nCI Entity\nci@example.com\n\n\n\n' | "${REPO}/template/scripts/create-project.sh" --with-private demo "${WD}/proj" >/dev/null
APP="${WD}/proj/demo"; cd "${APP}"
for s in back front; do
  [[ -d "${s}/.libs/vx-public/template" && -d "${s}/.libs/vx-private/nest/fakemod" ]] || fail "${s}: mounts missing"
  [[ "$(readlink "${s}/.libs/apptemplate")" == "vx-public/template" ]] || fail "${s}: .libs/apptemplate symlink wrong"
  git ls-files --error-unmatch "${s}/.libs/apptemplate" >/dev/null || fail "${s}/.libs/apptemplate not committed"
done
[[ "$(git config -f .gitmodules --get-regexp 'submodule\..*\.path' | wc -l | tr -d ' ')" == "4" ]] || fail "expected 4 submodules"

info "update_common.sh --pull-only (nothing new)"
scripts/update_common.sh --pull-only >/dev/null

info "upstream gets a commit; --pull-only brings it to both mounts"
git clone -q "${VX_PUBLIC_URL}" "${WD}/upstream-public"
( cd "${WD}/upstream-public" && echo upstream > UPSTREAM.txt && git add -A && git commit -q -m "feat: upstream" && git push -q origin main )
scripts/update_common.sh --pull-only >/dev/null
for s in back front; do [[ -f "${s}/.libs/vx-public/UPSTREAM.txt" ]] || fail "${s}: pull-only did not fast-forward"; done

info "local edit in the back mount: push mode commits, rebases, pushes, aligns, bumps"
echo local > back/.libs/vx-public/LOCAL.txt
scripts/update_common.sh >/dev/null
git -C "${VX_PUBLIC_URL}" show main:LOCAL.txt >/dev/null || fail "push did not reach origin"
[[ "$(git -C back/.libs/vx-public rev-parse HEAD)" == "$(git -C front/.libs/vx-public rev-parse HEAD)" ]] || fail "mounts differ"
[[ "$(git log -1 --format=%s)" == "chore: bump vx-public" ]] || fail "parent not bumped: $(git log -1 --format=%s)"
[[ -z "$(git status --porcelain)" ]] || fail "parent not clean after update_common"

info "legacy layout is refused"
LEG="${WD}/legacy"; mkdir -p "${LEG}/scripts" "${LEG}/back" "${LEG}/front"; cp "${REPO}/template/scripts/update_common.sh" "${LEG}/scripts/"
( cd "${LEG}" && git init -q -b main && printf '[submodule "back/.libs/nestcommon"]\n\tpath = back/.libs/nestcommon\n\turl = x\n' > .gitmodules )
if "${LEG}/scripts/update_common.sh" >/dev/null 2>&1; then fail "legacy layout accepted"; fi

info "deploy-full staging semantics: rsync -aL resolves .libs/apptemplate and modules_shared links"
mkdir -p back/src/modules_shared
ln -sfn ../../.libs/vx-public/nest/common back/src/modules_shared/common
ln -sfn ../../.libs/vx-private/nest/fakemod back/src/modules_shared/fakemod
STAGE="${WD}/stage"; mkdir -p "${STAGE}"
rsync -aL --delete --exclude=.git --exclude=node_modules --exclude=dist ./back/ "${STAGE}/"
[[ -f "${STAGE}/.libs/apptemplate/scripts/build-package.mjs" ]] || fail "apptemplate symlink not dereferenced"
[[ -f "${STAGE}/src/modules_shared/common/CommonModule.ts" && ! -L "${STAGE}/src/modules_shared/common" ]] || fail "modules_shared/common not resolved"
[[ -f "${STAGE}/src/modules_shared/fakemod/FakeModule.ts" ]] || fail "modules_shared/fakemod (vx-private) not resolved"
info "git flow OK"
