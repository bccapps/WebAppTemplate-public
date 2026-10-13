#!/bin/sh
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.

# Builds a macOS .dmg with hdiutil (no AppleScript/Finder, so it works in CI and over SSH).
#
#   make-dmg.sh --app <path/to/App.app> --out <file.dmg> [--name <volume name>]
#
# --name defaults to the .app name without extension. build-desktop.mjs computes --out (<Product>_<version>_<arch>.dmg).
set -eu

APP=""; OUT=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP" ] && [ -n "$OUT" ] || { echo "Usage: make-dmg.sh --app <App.app> --out <file.dmg> [--name <volume>]" >&2; exit 2; }
[ -d "$APP" ] || { echo "Application not found: $APP (run tauri build first)" >&2; exit 1; }
[ -n "$NAME" ] || NAME="$(basename "$APP" .app)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$(basename "$APP")"      # ditto keeps signature, links and attributes
ln -s /Applications "$STAGE/Applications"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=6 -ov "$OUT" >/dev/null
echo "DMG: $OUT ($(du -h "$OUT" | cut -f1))"
