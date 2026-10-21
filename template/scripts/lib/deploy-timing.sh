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
# Phase timing of deploy-full.sh. SOURCED (bash 3.2 compatible). Each measured phase prints one marker line
#   ==> [TIME] <label>: <duration>
# and is kept for the summary dt_summary prints at exit (success or failure), so the slow steps of a deploy are
# measured, not guessed. Durations are whole seconds.
#
#   t0=$(dt_now); ...; dt_record "<label>" "${t0}"
#
# Phases measured by run.sh before it execs deploy-full.sh arrive through the environment:
#   DEPLOY_TIMINGS     "<label>=<secs>;<label>=<secs>" (dt_import adds them first)
#   DEPLOY_STARTED_AT  epoch seconds of run.sh's start (the summary total includes run.sh's phases)
# =============================================================================

DT_LABELS=()
DT_SECS=()
DT_STARTED_AT="${DEPLOY_STARTED_AT:-$(date +%s)}"

dt_now() { date +%s; }

dt_format() {
  local s="$1"
  if [[ "${s}" -ge 60 ]]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "${s}"; fi
}

dt_add() {
  DT_LABELS+=("$1")
  DT_SECS+=("$2")
}

# dt_record <label> <start epoch>: records and prints the duration since <start>.
dt_record() {
  local label="$1" secs
  secs=$(( $(dt_now) - $2 ))
  dt_add "${label}" "${secs}"
  echo "==> [TIME] ${label}: $(dt_format "${secs}")"
}

# Imports the phases run.sh measured (DEPLOY_TIMINGS). Malformed items are ignored.
dt_import() {
  local item label secs
  local IFS=';'
  for item in ${DEPLOY_TIMINGS:-}; do
    label="${item%=*}"
    secs="${item##*=}"
    if [[ -n "${label}" && "${label}" != "${item}" && "${secs}" =~ ^[0-9]+$ ]]; then
      dt_add "${label}" "${secs}"
    fi
  done
}

# Prints every recorded phase in order, then the total since DT_STARTED_AT. No-op when nothing was measured.
dt_summary() {
  [[ ${#DT_LABELS[@]} -gt 0 ]] || return 0
  local i
  echo "==> [TIME] Summary"
  for ((i = 0; i < ${#DT_LABELS[@]}; i++)); do
    printf '    %-56s %8s\n' "${DT_LABELS[i]}" "$(dt_format "${DT_SECS[i]}")"
  done
  printf '    %-56s %8s\n' "total" "$(dt_format $(( $(dt_now) - DT_STARTED_AT )))"
}
