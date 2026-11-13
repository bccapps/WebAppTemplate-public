#!/bin/sh
# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================
#
# vx-secret-scan-hook
# Secret scan of a VX project, installed as .git/hooks/pre-commit and .git/hooks/pre-push by scripts/update_common.sh
# (scripts/secret-scan.mjs; source: the template's scripts/git-hooks/vx-secret-scan.sh, refreshed on each run: edit
# the template, not this copy). It runs gitleaks on:
#   - pre-commit: the staged changes (what the commit will contain);
#   - pre-push:   the commits being pushed that no remote-tracking branch has yet (merge commits included, `-m`).
# The configuration and the ignore file are those already COMMITTED (HEAD for a commit; what the remote has for a push),
# never the ones being committed: a change of .gitleaks.toml / .gitleaks.local.toml / .gitleaksignore is allowed, scanned
# with the previous configuration, and reported. `gitleaks:allow` comments are ignored, GITLEAKS_CONFIG* too. Then the
# project's own hook of the same name runs (kept by the installer as <hook>.local). Without gitleaks the commit or push
# is refused, with the way to install it. Template README, « Secret scanning ».

MIN_GITLEAKS=8.30.0
LEAK_EXIT=3
CONFIG_FILES=".gitleaks.toml .gitleaks.local.toml .gitleaksignore"
hook=$(basename "$0")
hooks_dir=$(cd "$(dirname "$0")" && pwd)
# Called by name from another hook manager (core.hooksPath): `vx-secret-scan.sh pre-commit|pre-push [hook arguments]`.
case "$hook" in
  pre-commit | pre-push) ;;
  *) if [ $# -gt 0 ]; then hook=$1; shift; fi ;;
esac
remote_name=${1:-}
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML

say() { printf 'secret scan (%s): %s\n' "$hook" "$*" >&2; }
tmp=""
cleanup() { if [ -n "$tmp" ] && [ -d "$tmp" ]; then rm -rf -- "$tmp"; fi; }
refuse() { say "$@"; cleanup; exit 1; }

# 0 when the dotted version $1 >= $2 (numeric fields).
version_at_least() {
  lowest=$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)
  [ "$lowest" = "$2" ]
}

# 0 for an empty or all-zero object name (a new or deleted ref).
is_zero() {
  case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac
}

INSTALL_HELP="Install gitleaks $MIN_GITLEAKS or later (macOS: brew install gitleaks; Linux: a release archive of https://github.com/gitleaks/gitleaks/releases), then run the same git command again."

command -v gitleaks >/dev/null 2>&1 || refuse "gitleaks is not installed: nothing is committed or pushed without the secret scan. $INSTALL_HELP"
version=$(gitleaks version 2>/dev/null | head -n 1)
version=${version#v}
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) version_at_least "$version" "$MIN_GITLEAKS" || refuse "gitleaks $version is too old for the generated .gitleaks.toml. $INSTALL_HELP" ;;
esac

root=$(git rev-parse --show-toplevel) || refuse "not inside a git work tree"
git_dir=$(git rev-parse --absolute-git-dir) || refuse "not inside a git work tree"
[ -n "$root" ] && [ -n "$git_dir" ] || refuse "not inside a git work tree"
# gitleaks runs from a scratch directory (below): a relative index path (partial commit) must survive that.
case "${GIT_INDEX_FILE:-}" in
  "" | /*) ;;
  *) GIT_INDEX_FILE="$PWD/$GIT_INDEX_FILE"; export GIT_INDEX_FILE ;;
esac
tmp=$(mktemp -d "${TMPDIR:-/tmp}/vx-secret-scan.XXXXXX") || refuse "cannot create a temporary directory"
[ -n "$tmp" ] || refuse "cannot create a temporary directory"
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM

LEAK_HELP="Remove the secret from what you commit or push (gitleaks printed where, with the value redacted). If it was ever pushed or shared, revoke or rotate it: removing it from git is not enough. A deliberately fake value written in clear carries FAKE or EXAMPLE right after its prefix (tk_FAKE…); a project-specific exception goes in .gitleaks.local.toml, reviewed and committed on its own (template README, « Secret scanning »)."

# Copies the scan configuration and ignore file of commit $1 (empty: the work tree, for a repository without history) to
# $tmp, mode 0600. A commit without .gitleaks.toml scans with gitleaks' default rules, never with a file being committed.
config_from() {
  (
    umask 077
    if [ -n "$1" ]; then
      git show "$1:.gitleaks.toml" > "$tmp/config.toml" 2>/dev/null || printf '[extend]\nuseDefault = true\n' > "$tmp/config.toml"
      git show "$1:.gitleaksignore" > "$tmp/.gitleaksignore" 2>/dev/null || : > "$tmp/.gitleaksignore"
    else
      if [ -f "$root/.gitleaks.toml" ]; then cat "$root/.gitleaks.toml" > "$tmp/config.toml"; else printf '[extend]\nuseDefault = true\n' > "$tmp/config.toml"; fi
      if [ -f "$root/.gitleaksignore" ]; then cat "$root/.gitleaksignore" > "$tmp/.gitleaksignore"; else : > "$tmp/.gitleaksignore"; fi
    fi
  )
}

# gitleaks git <args> with that configuration, values redacted, silent when clean. Returns gitleaks' status. Its source
# is $tmp (the repository through GIT_DIR / GIT_WORK_TREE): gitleaks also reads <source>/.gitleaksignore whatever
# --gitleaks-ignore-path says, and the work tree's one may be the file being committed.
scan() {
  GIT_DIR="$git_dir" GIT_WORK_TREE="$root" gitleaks git "$@" --config "$tmp/config.toml" --gitleaks-ignore-path "$tmp/.gitleaksignore" \
    --ignore-gitleaks-allow --redact --verbose --no-banner --log-level warn --exit-code "$LEAK_EXIT" "$tmp"
}

# Turns a gitleaks status into a verdict: a leak and a gitleaks failure are told apart.
verdict() {
  case "$1" in
    0) return 0 ;;
    "$LEAK_EXIT") refuse "$2 refused: a secret was found. $LEAK_HELP" ;;
    *) refuse "$2 refused: gitleaks failed (exit $1, see its message above: an unreadable .gitleaks.toml?); nothing was scanned to the end" ;;
  esac
}

# Warns when the given paths include a scan-configuration file.
warn_config_change() {
  [ -n "$1" ] || return 0
  say "WARNING: this $2 changes the secret-scan configuration ($(echo $1 | tr '\n' ' ')): it is scanned with the configuration already committed; have the change reviewed on its own."
}

input=""
case "$hook" in
  pre-commit)
    if git rev-parse -q --verify HEAD >/dev/null; then config_from HEAD; else config_from ""; fi
    # shellcheck disable=SC2086 # several paths on purpose
    warn_config_change "$(git diff --cached --name-only -- $CONFIG_FILES)" commit
    scan --pre-commit --staged
    verdict $? commit
    ;;
  pre-push)
    input=$(cat)
    while read -r local_ref local_sha remote_ref remote_sha; do
      [ -n "$local_sha" ] || continue
      is_zero "$local_sha" && continue
      if ! is_zero "$remote_sha" && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
        base=$remote_sha
        range="$remote_sha..$local_sha"
      else
        # A new branch (or a remote commit we do not have): what no remote-tracking branch has; the configuration of
        # the closest commit the remote already has, else the work tree (first push).
        base=$(git for-each-ref --format='%(objectname)' "refs/remotes/$remote_name/" 2>/dev/null | xargs git merge-base "$local_sha" 2>/dev/null | head -n 1)
        range="$local_sha --not --remotes"
      fi
      # shellcheck disable=SC2086 # the range is several git arguments on purpose
      [ -n "$(git rev-list -n 1 $range)" ] || continue
      config_from "$base"
      if [ -n "$base" ]; then
        # shellcheck disable=SC2086
        warn_config_change "$(git diff --name-only "$base" "$local_sha" -- $CONFIG_FILES)" push
      fi
      scan --log-opts="-m $range"
      verdict $? push
    done <<EOF
$input
EOF
    ;;
  *)
    refuse "installed under an unknown hook name; expected pre-commit or pre-push"
    ;;
esac

cleanup
trap - EXIT
local_hook="$hooks_dir/$hook.local"
if [ -x "$local_hook" ]; then
  if [ "$hook" = pre-push ] && [ -n "$input" ]; then
    printf '%s\n' "$input" | "$local_hook" "$@"
    exit $?
  fi
  exec "$local_hook" "$@" </dev/null
fi
exit 0
