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
# Scaffolds a brand-new project from WebAppTemplate. Thin wrapper: checks git / node >= 20 /
# npm, then runs the interactive wizard create-project.mjs (questions, modules, options:
# `scripts/create-project.sh --help`). The submodule / symlink logic lives in lib/libs.sh
# (also used by migrate-to-webapptemplate.sh).
#
# Usage:
#   scripts/create-project.sh [options] [<project-name> [parent-dir]]
#   --with-private / --with-users are kept as aliases of --private / --multi-user.
#
# Env overrides: VX_PUBLIC_URL, VX_PRIVATE_URL, LIB_BRANCH (see lib/libs.sh).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in git node npm; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "✖ ${tool} not found." >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "✖ Node >= 20 is required (found $(node -v))." >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/create-project.mjs" "$@"
