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
# Sourced by deploy-full.sh. Every deploy forces VALIDATION_TRACE=off in the env it ships, EXCEPT a preprod deploy: its
# env file is `back/.env.preprod` (run.sh preprod) or it says APP_ENV=preprod. The file name alone never makes a deploy
# "not production" (a custom BACK_ENV_FILE is treated as production).

# vg_is_preprod <env file path> <APP_ENV value>: 0 for a preprod deploy.
vg_is_preprod() {
  [[ "$(basename "$1")" == ".env.preprod" || "$2" == "preprod" ]]
}

# vg_app_env <env file>: last APP_ENV of the file, unquoted, lower case ("" when absent).
vg_app_env() {
  # `|| true`: deploy-full.sh runs under `set -euo pipefail`, and grep finding no APP_ENV must not stop the deploy.
  { grep -E '^[[:space:]]*(export[[:space:]]+)?APP_ENV=' "$1" 2>/dev/null || true; } | tail -n 1 | sed -E 's/^[^=]*=//; s/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']$//' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

# vg_guard_prod_env <source env file> <staged env file>
# Not preprod: appends VALIDATION_TRACE=off to the staged env (the env the containers get; the last assignment wins) and
# warns loudly when APP_ENV is not `prod` (a back/.env copied from the example says `dev`). Never fails the deploy.
vg_guard_prod_env() {
  local source_file="$1" staged="$2" app_env
  app_env="$(vg_app_env "${staged}")"
  vg_is_preprod "${source_file}" "${app_env}" && return 0
  if [[ "${app_env}" != "prod" ]]; then
    echo "WARNING: deploy of ${source_file} with APP_ENV='${app_env:-<unset>}' treated as production: set APP_ENV=prod (or preprod). Validation traces are forced off for this deploy." >&2
  fi
  printf '\n# Forced by deploy-full.sh (lib/validation-guard.sh): never validation traces outside dev/preprod.\nVALIDATION_TRACE=off\n' >> "${staged}"
}
