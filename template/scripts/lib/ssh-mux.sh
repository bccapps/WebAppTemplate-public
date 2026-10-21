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
# SSH connection reuse for deploy-full.sh. SOURCED (bash 3.2 compatible).
#
# Every `docker --context ssh://…` call, every ssh and every scp of a deploy otherwise opens its own SSH connection
# (TCP + key exchange + authentication: several network round trips each, dozens of calls per deploy, one every 3 s
# while waiting for the back to become healthy). ssh_mux_enable puts `ssh` and `scp` wrappers first on PATH that add
# ControlMaster=auto + ControlPersist: the first connection to a host becomes the master, every later one rides on it.
# The docker CLI's SSH helper runs `ssh` from PATH, so docker calls are covered too; scp passes the -o options to the
# ssh it spawns. When a multiplexed session is refused, ssh falls back to a direct connection.
#
#   DEPLOY_SSH_MUX=0   disables it (plain connections, as before)
#
# ssh_mux_close (EXIT trap of deploy-full.sh) closes the masters and removes the socket directory.
# =============================================================================

SSH_MUX_DIR=""
SSH_MUX_REAL_SSH=""

ssh_mux_enable() {
  [[ "${DEPLOY_SSH_MUX:-1}" != "0" ]] || return 0
  local real_scp opts
  SSH_MUX_REAL_SSH="$(command -v ssh || true)"
  real_scp="$(command -v scp || true)"
  [[ -n "${SSH_MUX_REAL_SSH}" && -n "${real_scp}" ]] || return 0
  # Short absolute path: a unix socket path is limited to ~104 bytes on macOS, whose TMPDIR alone is ~50.
  SSH_MUX_DIR="$(mktemp -d /tmp/vxmux.XXXXXX 2>/dev/null)" || { SSH_MUX_DIR=""; return 0; }
  mkdir -p "${SSH_MUX_DIR}/bin"
  opts="-o ControlMaster=auto -o ControlPath=${SSH_MUX_DIR}/%C -o ControlPersist=120 -o ServerAliveInterval=30"
  printf '#!/bin/sh\nexec "%s" %s "$@"\n' "${SSH_MUX_REAL_SSH}" "${opts}" > "${SSH_MUX_DIR}/bin/ssh"
  printf '#!/bin/sh\nexec "%s" %s "$@"\n' "${real_scp}" "${opts}" > "${SSH_MUX_DIR}/bin/scp"
  chmod 755 "${SSH_MUX_DIR}/bin/ssh" "${SSH_MUX_DIR}/bin/scp"
  export PATH="${SSH_MUX_DIR}/bin:${PATH}"
  hash -r
}

ssh_mux_close() {
  [[ -n "${SSH_MUX_DIR}" && -d "${SSH_MUX_DIR}" ]] || return 0
  local sock
  for sock in "${SSH_MUX_DIR}"/*; do
    [[ -S "${sock}" ]] || continue
    "${SSH_MUX_REAL_SSH}" -o ControlPath="${sock}" -O exit mux >/dev/null 2>&1 || true
  done
  rm -rf "${SSH_MUX_DIR}"
  SSH_MUX_DIR=""
}
