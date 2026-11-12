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
# Commit a list of paths that may be tracked, untracked, git-ignored or absent, without ever failing on
# one of them and without forcing anything. SOURCED by update_common.sh (tested by git-paths.test.mjs).
#
# Why: `git commit -- <path>` aborts with "pathspec did not match any file(s) known to git" for a path
# git does not track (a project that ignores its root CLAUDE.md on purpose), and `git add <ignored path>`
# fails too; under `set -e` either one stopped the whole sync.

# vx_commit_paths [--adopt] <message> <path>...
#   For each path, relative to the cwd (the repo root):
#     - tracked          -> staged (`git add -- <path>`, an ignore rule does not matter for a tracked path)
#     - untracked        -> staged only with --adopt, when it exists and is NOT ignored (never `git add -f`)
#     - ignored/absent   -> left alone
#   Then ONE commit limited to the paths that really have staged changes (`git commit -- <those paths>`):
#   whatever else the user staged stays staged and out of this commit.
#   Returns 0 when a commit was made, 10 when there was nothing to commit (not an error: test with `if`).
vx_commit_paths() {
  local adopt=0
  if [[ "${1:-}" == "--adopt" ]]; then adopt=1; shift; fi
  local message="$1"; shift
  local path staged=()
  for path in "$@"; do
    if git ls-files --error-unmatch -- "${path}" >/dev/null 2>&1; then
      git add -- "${path}" >/dev/null 2>&1 || continue
    elif (( adopt )) && [[ -e "${path}" || -L "${path}" ]] && ! git check-ignore -q -- "${path}" 2>/dev/null; then
      git add -- "${path}" >/dev/null 2>&1 || continue
    else
      continue
    fi
    git diff --cached --quiet -- "${path}" 2>/dev/null || staged+=("${path}")
  done
  (( ${#staged[@]} > 0 )) || return 10
  git commit -q -m "${message}" -- "${staged[@]}"
}
