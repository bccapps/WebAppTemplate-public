#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

set -euo pipefail

# ============================================================
# install.sh — build the desktop app for THIS machine and install it
# ============================================================
# Usage:
#   ./scripts/install.sh <target>             target: macos (mac), linux, windows (win), or a target id
#                                             (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64); mandatory
#   ./scripts/install.sh <target> --no-build  install the last build
#   ./scripts/install.sh <target> --clean     full rebuild (production node_modules, DESKTOP_CLEAN=1 for the hook)
#
# The target must be this machine's (an app is installed where it is built). Platform names resolve to this
# machine's architecture. Install locations:
#   - macOS: /Applications/<Product>.app (sudo only when /Applications is not writable).
#   - Linux: an AppImage (self-contained single file) goes to /usr/local/bin/<slug>; when tauri cannot produce one, the
#     shell binary and its resources go to /usr/local/lib/<slug> with a /usr/local/bin/<slug> link. Both add
#     /usr/local/share/applications/<slug>.desktop and an icon. Uses sudo.
#   - Windows (Git Bash): %LOCALAPPDATA%\Programs\<Product> (no admin rights), desktop and Start menu shortcuts, entry in
#     "Installed apps" (HKCU) whose uninstaller removes all of it.
# The user data (OS data folder named after the identifier) is never touched, neither on reinstall nor on uninstall.
# Project hook: scripts-local/desktop-prepare.sh <target> (DESKTOP_PREPARE_HOOK), see scripts/desktop/common.sh.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
# shellcheck source=desktop/common.sh
source "${SCRIPT_DIR}/desktop/common.sh"

usage() { sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \{0,1\}//'; }

BUILD=1; REQUESTED=""
for arg in "$@"; do
  case "${arg}" in
    --no-build) BUILD=0 ;;
    --clean) export DESKTOP_CLEAN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unknown option: ${arg}"; exit 2 ;;
    *) [[ -z "${REQUESTED}" ]] || { err "One target only"; exit 2; }; REQUESTED="${arg}" ;;
  esac
done
[[ -n "${REQUESTED}" ]] || { err "Missing target (macos, linux, windows or a target id)"; usage; exit 2; }

desktop_check_project
HOST="$(host_target)"
case "${REQUESTED}" in
  macos|mac|darwin) TARGET="darwin-${HOST##*-}" ;;
  linux) TARGET="linux-${HOST##*-}" ;;
  windows|win) TARGET="win-${HOST##*-}" ;;
  darwin-arm64|darwin-x64|linux-x64|linux-arm64|win-x64) TARGET="${REQUESTED}" ;;
  *) err "Unknown target: ${REQUESTED} (macos, linux, windows or a target id)"; exit 2 ;;
esac
[[ "${TARGET}" == "${HOST}" ]] || { err "${TARGET} cannot be installed on this machine (${HOST}): build its package with scripts/bundle.sh"; exit 2; }

OS="${TARGET%%-*}"
PRODUCT="$(desktop_field 'c.productName')"
IDENTIFIER="$(desktop_field 'c.identifier')"
SLUG="$(printf '%s' "${PRODUCT}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
RESOURCES="$(resources_dir "${TARGET}")"
BUNDLE_DIR="$(release_dir)/bundle"
ICON_PNG="${PROJECT_ROOT}/desktop/src-tauri/icons/128x128.png"

# Runs "$@" as root only when <dir> is not writable by the current user.
as_owner_of() {
  local dir="$1"; shift
  if [[ -w "${dir}" ]]; then "$@"; else sudo "$@"; fi
}

build() {
  info "${PRODUCT}: build for ${TARGET}"
  build_web
  run_prepare_hook "${TARGET}"
  case "${OS}" in
    darwin) assemble "${TARGET}" --bundle --bundles app --no-dmg ;;
    linux)
      rm -f "${BUNDLE_DIR}"/appimage/*.AppImage 2>/dev/null || true
      assemble "${TARGET}" --bundle --bundles appimage \
        || { warn "No AppImage (see the tauri output above): installing the binary and its resources instead"; assemble "${TARGET}" --bundle --bundles none; }
      ;;
    win) assemble "${TARGET}" --bundle --bundles none ;;
  esac
  ok "Build done"
}

# Quits the running copy (single instance: it would only be focused), matched on <pattern>.
stop_running() {
  local pattern="$1"
  pgrep -f "${pattern}" >/dev/null 2>&1 || return 0
  info "Quitting the running ${PRODUCT}"
  pkill -TERM -f "${pattern}" || true   # the shell stops its processes on SIGTERM
  for _ in $(seq 1 20); do pgrep -f "${pattern}" >/dev/null 2>&1 || return 0; sleep 0.5; done
  err "${PRODUCT} is still running: quit it and run again with --no-build"; return 1
}

install_macos() {
  local app="${BUNDLE_DIR}/macos/${PRODUCT}.app" dest="/Applications/${PRODUCT}.app"
  [[ -d "${app}" ]] || { err "No build found (${app}): run without --no-build"; exit 1; }
  stop_running "${dest}/Contents/MacOS/"
  info "Copying ${PRODUCT}.app to /Applications"
  as_owner_of /Applications rm -rf "${dest}"
  as_owner_of /Applications ditto "${app}" "${dest}"   # keeps symlinks, permissions and the signature
  ok "Installed: ${dest}"
  echo "  Logs: ~/Library/Application Support/${IDENTIFIER}/logs"
}

# Menu entry and icon of the Linux install, launching <exec>.
linux_desktop_entry() {
  local exec="$1" tmp
  tmp="$(mktemp)"
  printf '[Desktop Entry]\nType=Application\nName=%s\nExec="%s"\nIcon=%s\nTerminal=false\nCategories=Graphics;AudioVideo;\nStartupWMClass=%s\n' \
    "${PRODUCT}" "${exec}" "${SLUG}" "${PRODUCT}" > "${tmp}"
  sudo install -D -m 0644 "${tmp}" "/usr/local/share/applications/${SLUG}.desktop"
  rm -f "${tmp}"
  [[ -f "${ICON_PNG}" ]] && sudo install -D -m 0644 "${ICON_PNG}" "/usr/local/share/icons/hicolor/128x128/apps/${SLUG}.png"
  command -v update-desktop-database >/dev/null && sudo update-desktop-database /usr/local/share/applications || true
}

install_linux() {
  local bin="/usr/local/bin/${SLUG}" lib="/usr/local/lib/${SLUG}" appimage shell
  appimage="$(find "${BUNDLE_DIR}/appimage" -maxdepth 1 -name '*.AppImage' -newer "${RESOURCES}/back/dist/main.js" 2>/dev/null | head -n 1)"
  stop_running "${bin}|${lib}/desktop-shell"
  if [[ -n "${appimage}" ]]; then
    info "Installing the AppImage as ${bin}"
    sudo rm -rf "${lib}"   # a previous non-AppImage install
    sudo install -D -m 0755 "${appimage}" "${bin}"
  else
    shell="$(release_dir)/desktop-shell"
    [[ -x "${shell}" && -f "${RESOURCES}/back/dist/main.js" ]] || { err "No build found (${shell}, ${RESOURCES}): run without --no-build"; exit 1; }
    info "Installing the binary and its resources in ${lib}"
    sudo rm -rf "${lib}" "${bin}"
    sudo mkdir -p "${lib}"
    sudo cp -R "${RESOURCES}/." "${lib}/"
    sudo install -m 0755 "${shell}" "${lib}/desktop-shell"   # resources are found next to the real executable
    sudo ln -s "${lib}/desktop-shell" "${bin}"
  fi
  linux_desktop_entry "${bin}"
  ok "Installed: ${bin}"
  echo "  Data and logs: ~/.local/share/${IDENTIFIER}"
}

# Creates the Windows shortcut <lnk> to <exe> (PowerShell, WScript.Shell).
win_shortcut() {
  powershell.exe -NoProfile -Command "\$s = (New-Object -ComObject WScript.Shell).CreateShortcut('$1'); \$s.TargetPath = '$2'; \$s.WorkingDirectory = '$3'; \$s.IconLocation = '$2,0'; \$s.Save()"
}

win_folder() { powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('$1')" | tr -d '\r'; }

install_windows() {
  local shell="$(release_dir)/desktop-shell.exe" dir dirw exew desktop programs key="HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${IDENTIFIER}"
  [[ -f "${shell}" && -f "${RESOURCES}/back/dist/main.js" ]] || { err "No build found (${shell}, ${RESOURCES}): run without --no-build"; exit 1; }
  dir="$(cygpath -u "${LOCALAPPDATA:?LOCALAPPDATA is not set}")/Programs/${PRODUCT}"
  dirw="$(cygpath -w "${dir}")"; exew="${dirw}\\${PRODUCT}.exe"
  desktop="$(win_folder Desktop)\\${PRODUCT}.lnk"
  programs="$(win_folder Programs)\\${PRODUCT}.lnk"
  if tasklist //FI "IMAGENAME eq ${PRODUCT}.exe" 2>/dev/null | grep -qi "${PRODUCT}.exe"; then
    info "Quitting the running ${PRODUCT}"
    taskkill //IM "${PRODUCT}.exe" >/dev/null 2>&1 || true
    sleep 3
  fi
  info "Copying to ${dirw}"
  rm -rf "${dir}"
  mkdir -p "${dir}"
  cp -R "${RESOURCES}/." "${dir}/"
  cp "${shell}" "${dir}/${PRODUCT}.exe"
  [[ -f "$(release_dir)/WebView2Loader.dll" ]] && cp "$(release_dir)/WebView2Loader.dll" "${dir}/"
  win_shortcut "${desktop}" "${exew}" "${dirw}"
  win_shortcut "${programs}" "${exew}" "${dirw}"
  # The last line deletes the folder from a detached cmd, once this script has exited.
  printf '@echo off\r\ntaskkill /IM "%s.exe" >nul 2>&1\r\ndel "%s" >nul 2>&1\r\ndel "%s" >nul 2>&1\r\nreg delete "%s" /f >nul 2>&1\r\ncd /d "%%TEMP%%"\r\nstart "" /b cmd /c "ping -n 3 127.0.0.1 >nul & rd /s /q "%s""\r\n' \
    "${PRODUCT}" "${desktop}" "${programs}" "${key}" "${dirw}" > "${dir}/uninstall.cmd"
  local size_kb version
  size_kb="$(du -sk "${dir}" | cut -f1)"
  version="$(node -e "import('./desktop/scripts/sync-tauri-config.mjs').then((m) => console.log(m.projectVersion(process.cwd()) ?? ''))")"
  # MSYS2_ARG_CONV_EXCL: keeps Git Bash from rewriting the /v, /d... switches of reg as paths.
  local reg=(env MSYS2_ARG_CONV_EXCL='*' reg add "${key}" /f)
  "${reg[@]}" /v DisplayName /t REG_SZ /d "${PRODUCT}" >/dev/null
  "${reg[@]}" /v DisplayVersion /t REG_SZ /d "${version}" >/dev/null
  "${reg[@]}" /v DisplayIcon /t REG_SZ /d "${exew}" >/dev/null
  "${reg[@]}" /v InstallLocation /t REG_SZ /d "${dirw}" >/dev/null
  "${reg[@]}" /v UninstallString /t REG_SZ /d "\"${dirw}\\uninstall.cmd\"" >/dev/null
  "${reg[@]}" /v EstimatedSize /t REG_DWORD /d "${size_kb}" >/dev/null
  "${reg[@]}" /v NoModify /t REG_DWORD /d 1 >/dev/null
  "${reg[@]}" /v NoRepair /t REG_DWORD /d 1 >/dev/null
  ok "Installed: ${exew} (desktop and Start menu shortcuts, Installed apps)"
  echo "  Data and logs: %LOCALAPPDATA%\\${IDENTIFIER}"
}

[[ ${BUILD} -eq 1 ]] && build
case "${OS}" in
  darwin) install_macos ;;
  linux) install_linux ;;
  win) install_windows ;;
esac
