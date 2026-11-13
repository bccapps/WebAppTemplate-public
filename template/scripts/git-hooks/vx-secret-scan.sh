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
# the template, not this copy). It runs gitleaks with the project's .gitleaks.toml on:
#   - pre-commit: the staged changes (what the commit will contain);
#   - pre-push:   the commits being pushed that no remote-tracking branch has yet.
# Then it runs the project's own hook of the same name, kept by the installer as <hook>.local. Without gitleaks the
# commit or push is refused, with the way to install it. Template README, « Secret scanning ».

MIN_GITLEAKS=8.30.0
hook=$(basename "$0")
hooks_dir=$(cd "$(dirname "$0")" && pwd)

say() { printf 'secret scan (%s): %s\n' "$hook" "$*" >&2; }
refuse() { say "$@"; exit 1; }

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

LEAK_HELP="Remove the secret from what you commit or push (gitleaks printed where, with the value redacted). If it was ever pushed or shared, revoke or rotate it: removing it from git is not enough. A deliberately fake value written in clear carries FAKE or EXAMPLE right after its prefix (tk_FAKE…); a project-specific exception goes in .gitleaks.local.toml (template README, « Secret scanning »)."

# gitleaks git <args>, with the project's configuration and ignore file, values redacted; silent when clean.
scan() {
  if [ -f "$root/.gitleaks.toml" ]; then
    gitleaks git "$@" --config "$root/.gitleaks.toml" --gitleaks-ignore-path "$root" --redact --verbose --no-banner --log-level warn --exit-code 1 "$root"
  else
    gitleaks git "$@" --gitleaks-ignore-path "$root" --redact --verbose --no-banner --log-level warn --exit-code 1 "$root"
  fi
}

input=""
case "$hook" in
  pre-commit)
    scan --pre-commit --staged || refuse "commit refused. $LEAK_HELP"
    ;;
  pre-push)
    input=$(cat)
    failed=0
    while read -r local_ref local_sha remote_ref remote_sha; do
      [ -n "$local_sha" ] || continue
      is_zero "$local_sha" && continue
      if is_zero "$remote_sha" || ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
        range="$local_sha --not --remotes"
      else
        range="$remote_sha..$local_sha"
      fi
      # shellcheck disable=SC2086 # the range is several git arguments on purpose
      [ -n "$(git rev-list -n 1 $range)" ] || continue
      scan --log-opts="$range" || failed=1
    done <<EOF
$input
EOF
    [ "$failed" -eq 0 ] || refuse "push refused. $LEAK_HELP"
    ;;
  *)
    refuse "installed under an unknown hook name; expected pre-commit or pre-push"
    ;;
esac

local_hook="$hooks_dir/$hook.local"
if [ -x "$local_hook" ]; then
  if [ "$hook" = pre-push ] && [ -n "$input" ]; then
    printf '%s\n' "$input" | "$local_hook" "$@"
    exit $?
  fi
  exec "$local_hook" "$@" </dev/null
fi
exit 0
