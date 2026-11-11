#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

# Validation traces never run in production (nest/common/README.md, « Validation par observation »).
# Sourced by deploy-full.sh. A production deploy is one whose back env file is `back/.env` (run.sh prod, a plain
# deploy-full.sh); `back/.env.preprod` (run.sh preprod) is left alone.

# vg_is_prod_env_file <env file path>: 0 when the deploy ships the production back env.
vg_is_prod_env_file() {
  [[ "$(basename "$1")" == ".env" ]]
}

# vg_guard_prod_env <source env file> <staged env file>
# Production deploy only: forces VALIDATION_TRACE=off in the staged env (the env the containers get; the last assignment
# wins), whatever APP_ENV says, and warns loudly when APP_ENV is not `prod` (a back/.env copied from the example says
# `dev`: dev-only behaviours, such as the validation traces, would otherwise switch on). Never fails the deploy.
vg_guard_prod_env() {
  local source_file="$1" staged="$2" app_env
  vg_is_prod_env_file "${source_file}" || return 0
  # `|| true`: deploy-full.sh runs under `set -euo pipefail`, and grep finding no APP_ENV must not stop the deploy.
  app_env="$({ grep -E '^[[:space:]]*APP_ENV=' "${staged}" 2>/dev/null || true; } | tail -n 1 | sed -E 's/^[^=]*=//; s/^["'\'']//; s/["'\'']$//' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "${app_env}" != "prod" ]]; then
    echo "WARNING: production deploy with APP_ENV='${app_env:-<unset>}' in ${source_file}: set APP_ENV=prod. Validation traces are forced off for this deploy." >&2
  fi
  printf '\n# Forced by deploy-full.sh (lib/validation-guard.sh): never validation traces in production.\nVALIDATION_TRACE=off\n' >> "${staged}"
}
