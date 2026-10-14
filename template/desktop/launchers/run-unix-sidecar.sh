#!/bin/sh

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

# Launcher of a desktop sidecar on macOS / Linux: checks its prerequisites with the user's own PATH, then runs it.
#
#   run-unix-sidecar.sh [--require <command>]... [--hint <text>] -- <command> [args...]
#
# Why it exists: an application started from the Finder / the launcher does not get the PATH of the user's login shell
# (Homebrew, nvm, ~/.local/bin...), so `tmux`, `git` or an AI CLI installed there would not be found by the sidecar, nor by
# what it spawns. This script reads the PATH of the login shell once, adds the usual directories, verifies the `--require`d
# commands and `exec`s the command (the sidecar keeps the process id the shell supervises).
# A missing prerequisite is reported on stderr (the sidecar log) with the hint and the script exits with code 3: declare the
# sidecar `"optional": true` in desktop.config.json and the app then starts without it.

REQUIRES=""
HINT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require) [ $# -ge 2 ] || { echo "run-unix-sidecar: --require needs a command" >&2; exit 2; }; REQUIRES="$REQUIRES $2"; shift 2 ;;
    --hint) [ $# -ge 2 ] || { echo "run-unix-sidecar: --hint needs a text" >&2; exit 2; }; HINT="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "run-unix-sidecar: unknown option $1" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "run-unix-sidecar: no command to run" >&2; exit 2; }

# PATH of the user's login shell (bash, zsh, fish quote PATH as colon separated), then the usual directories.
LOGIN_SHELL="${SHELL:-/bin/sh}"
LOGIN_PATH="$("$LOGIN_SHELL" -l -c 'printf %s "$PATH"' 2>/dev/null || true)"
[ -n "$LOGIN_PATH" ] && PATH="$LOGIN_PATH:$PATH"
for dir in /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin "$HOME/.local/bin" "$HOME/.cargo/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH

MISSING=""
for cmd in $REQUIRES; do
  command -v "$cmd" >/dev/null 2>&1 || MISSING="$MISSING $cmd"
done
if [ -n "$MISSING" ]; then
  echo "run-unix-sidecar: missing prerequisite(s):$MISSING" >&2
  [ -n "$HINT" ] && echo "run-unix-sidecar: $HINT" >&2
  echo "run-unix-sidecar: the sidecar is not started; the rest of the application works." >&2
  exit 3
fi

exec "$@"
