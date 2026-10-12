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
# Scaffolds a brand-new project from WebAppTemplate: monorepo layout, the shared
# library submodules (vx-public always, vx-private with --with-private; each mounted
# in back/.libs and front/.libs, plus the .libs/apptemplate -> vx-public/template
# symlinks — see lib/libs.sh), the infra config
# files (via link-config.mjs), a one-shot copy of the base UI components /
# minimal back skeleton (via apply-component-templates.mjs — NEVER re-run
# after this), shared-modules.json, AGENTS.md/CLAUDE.md, and an initial commit
# (+ optional GitHub repo creation & push).
#
# RESUMABLE: if PROJECT_ROOT already exists and contains a git repo, the
# script resumes instead of failing — each step detects what's already done
# (submodule declared, symlink present, file written, components copied,
# GitHub repo already created...) and skips it, like migrate-to-submodules.sh.
# It only refuses a PROJECT_ROOT that already exists, is non-empty, and is
# NOT a git repo (unrelated content — never overwritten).
# apply-component-templates.mjs itself stays one-shot (it still fails loudly
# if its own targets exist); this script skips calling it again once the
# component copy has already landed (checked via front/src/main.tsx +
# back/src/main.ts).
#
# Usage:
#   scripts/create-project.sh [--with-private [--with-users]] <project-name> [parent-dir]
#   (parent-dir defaults to the current directory.)
#   --with-private  also mount vx-private (needs read access to the private repository)
#   --with-users    (requires --with-private) enable user management: lists the `user`
#                   module and what it needs (nest: user, commerce, infra, oauth;
#                   react: user, commerce, infra) in shared-modules.json
#
# Env overrides:
#   VX_PUBLIC_URL    (default https://github.com/bccapps/WebAppTemplate-public.git)
#   VX_PRIVATE_URL   (default https://github.com/bccapps/WebAppTemplate-private.git)
#   LIB_BRANCH       (default main)
#   VX_SKIP_INSTALL=1  skip npm install;  VX_SKIP_GITHUB=1  skip GitHub repo creation/push (tests)
# =============================================================================

set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m  %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m  %s\n' "$*"; }

SCRIPT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/libs.sh
source "${SCRIPT_SRC_DIR}/lib/libs.sh"

WITH_PRIVATE=0
WITH_USERS=0
POSITIONAL=()
for arg in "$@"; do
  case "${arg}" in
    --with-private) WITH_PRIVATE=1 ;;
    --with-users) WITH_USERS=1 ;;
    -*) echo "✖ unknown option: ${arg}" >&2; exit 2 ;;
    *) POSITIONAL+=("${arg}") ;;
  esac
done
set -- "${POSITIONAL[@]}"
if [[ "${WITH_USERS}" -eq 1 && "${WITH_PRIVATE}" -eq 0 ]]; then
  echo "✖ --with-users requires --with-private (the user module is private)." >&2; exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git introuvable." >&2; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node introuvable." >&2; exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm introuvable." >&2; exit 1
fi

PROJECT_NAME="${1:-}"
if [[ -z "${PROJECT_NAME}" ]]; then
  echo "Usage: scripts/create-project.sh [--with-private [--with-users]] <project-name> [parent-dir]" >&2
  exit 1
fi
if [[ ! "${PROJECT_NAME}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "✖ <project-name> must be kebab-case (e.g. my-new-app)." >&2
  exit 1
fi

PARENT_DIR="$(cd "${2:-$PWD}" && pwd)"
PROJECT_ROOT="${PARENT_DIR}/${PROJECT_NAME}"

RESUME=0
if [[ -e "${PROJECT_ROOT}" ]]; then
  if [[ -e "${PROJECT_ROOT}/.git" ]]; then
    RESUME=1
  elif [[ -z "$(ls -A "${PROJECT_ROOT}" 2>/dev/null)" ]]; then
    RESUME=0
  else
    echo "✖ ${PROJECT_ROOT} already exists, is not empty, and is not a git repo — check it manually." >&2
    exit 1
  fi
fi

# --- Prompts (Enter accepts the shown default) ---------------------------
default_site_name="$(echo "${PROJECT_NAME}" | sed -E 's/(^|-)([a-z])/\1\U\2/g; s/-/ /g')"

read -rp "Site name [${default_site_name}]: " SITE_NAME
SITE_NAME="${SITE_NAME:-${default_site_name}}"

read -rp "Publisher entity name: " ENTITY_NAME
read -rp "Contact email: " CONTACT_EMAIL

read -rp "GitHub organization [bccapps]: " GITHUB_ORG
GITHUB_ORG="${GITHUB_ORG:-bccapps}"

read -rp "Backend port (NODE_PORT) [3000]: " NODE_PORT
NODE_PORT="${NODE_PORT:-3000}"

read -rp "Frontend port (FRONT_PORT) [5173]: " FRONT_PORT
FRONT_PORT="${FRONT_PORT:-5173}"

if [[ "${RESUME}" -eq 1 ]]; then
  info "Resuming existing project at ${PROJECT_ROOT}..."
else
  info "Creating ${PROJECT_ROOT}..."
fi
mkdir -p "${PROJECT_ROOT}/front/src" "${PROJECT_ROOT}/back/src"

cd "${PROJECT_ROOT}"
git init -q -b main
ok "git repository initialized."

# Idempotent helpers (add_submodule / symlink) live in lib/libs.sh ---------
random_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 32
}

# 32 raw random bytes, base64-encoded — for CRYPT_DB_MASTER_KEY /
# CRYPT_SESSION_PRIVATE_KEY, which decode the value as base64/hex bytes
# (a tr -dc alnum string like random_password() would not decode to 32 bytes).
random_key_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    LC_ALL=C head -c 32 /dev/urandom | base64
  fi
}

# Generates <out> from <example> (front|back .env.example): for each "VAR=value"
# pair, uncomments/overwrites the first line matching "VAR=" (commented or not)
# in <out>, or appends it if absent. Everything else in the example (including
# fully-commented "Connexions additionnelles" / "Routage module -> connexion"
# blocks) is copied through untouched. Skips entirely if <out> already exists —
# never overwrites a dev env you may have since hand-edited.
generate_env_dev() {
  local example="$1" out="$2"; shift 2
  if [[ -f "${out}" ]]; then
    ok "${out} already present — kept as-is."
    return
  fi
  if [[ ! -f "${example}" ]]; then
    warn "${example} missing — cannot generate ${out}."
    return
  fi
  cp "${example}" "${out}"
  local pair var value
  for pair in "$@"; do
    var="${pair%%=*}"
    value="${pair#*=}"
    if grep -qE "^#? ?${var}=" "${out}"; then
      awk -v var="${var}" -v val="${value}" '
        BEGIN { done = 0 }
        !done && $0 ~ ("^#? ?" var "=") { print var "=" val; done = 1; next }
        { print }
      ' "${out}" > "${out}.tmp" && mv "${out}.tmp" "${out}"
    else
      printf '%s=%s\n' "${var}" "${value}" >> "${out}"
    fi
  done
  ok "${out} written."
}

info "Mounting the shared libraries..."
vx_setup_libs "${WITH_PRIVATE}"

info "Writing baseline .gitignore (before npm install — otherwise node_modules gets committed)..."
if [[ -f .gitignore ]]; then
  ok ".gitignore already present — kept as-is."
else
  cat > .gitignore <<'GITIGNORE'
# OS / editor
.DS_Store
*.log
.vscode/*
!.vscode/extensions.json
.idea

# Node
node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build output
dist
dist-ssr
build
*.tsbuildinfo

# Env
.env*
*.local

# Shared modules (materialized as symlinks by link-shared.mjs)
modules_shared

# Root-only scratch scripts; front/scripts and back/scripts are versioned.
/scripts/
GITIGNORE
  ok ".gitignore written."
fi

info "Linking root-level pointers (scripts, CLAUDE.md, AGENTS.md)..."
vx_link_root_pointers
vx_link_symlink front/.libs/apptemplate/CLAUDE.md CLAUDE.md
vx_link_symlink CLAUDE.md AGENTS.md
ok "Root symlinks ready."

info "Materializing infra config files (link-config.mjs)..."
node scripts/link-config.mjs "${PROJECT_ROOT}"

info "Generating back/.env.dev (from back/.env.example)..."
generate_env_dev back/.env.example back/.env.dev \
  "APP_ENV=dev" \
  "PROJECT_NAME=${PROJECT_NAME}" \
  "NODE_PORT=${NODE_PORT}" \
  "FRONT_PORT=${FRONT_PORT}" \
  "CLIENT_ORIGINS=http://localhost:${FRONT_PORT}" \
  "CRYPT_DB_MASTER_KEY=$(random_key_b64)" \
  "CRYPT_SESSION_PRIVATE_KEY=$(random_key_b64)" \
  "DISABLE_TRANSPORT_CRYPTO=true" \
  "REDIS_URL=redis://localhost:6379" \
  "DB_HOST=localhost" \
  "DB_PORT=$((NODE_PORT + 1))" \
  "DB_USER=postgres" \
  "DB_PASSWORD=$(random_password)" \
  "DB_NAME=${PROJECT_NAME}"

info "Generating front/.env.dev (from front/.env.example)..."
generate_env_dev front/.env.example front/.env.dev \
  "PROJECT_NAME=${PROJECT_NAME}" \
  "VITE_PROJECT_NAME=${SITE_NAME}" \
  "VITE_PROJECT_DESCRIPTION=${PROJECT_NAME}" \
  "CLOUDFLARE_PAGES_PROJECT=${PROJECT_NAME}" \
  "VITE_FRONT_URL=http://localhost:${FRONT_PORT}" \
  "VITE_API_URL=/api/v1" \
  "VITE_API_PORT=${NODE_PORT}" \
  "VITE_PORT=${FRONT_PORT}"

info "Writing shared-modules.json (from shared-modules.json.example)..."
if [[ -f shared-modules.json ]]; then
  ok "shared-modules.json already present — kept as-is."
else
  # Anonymous baseline = the example (no `user`). --with-users adds the user module and
  # what it needs (checked with `check-boundaries --report` on the private repository).
  NEST_MODULES='["common","database"]'
  REACT_MODULES='["common"]'
  if [[ "${WITH_USERS}" -eq 1 ]]; then
    NEST_MODULES='["common","database","infra","commerce","oauth","user"]'
    REACT_MODULES='["common","infra","commerce","user"]'
  fi
  NEST_MODULES="${NEST_MODULES}" REACT_MODULES="${REACT_MODULES}" node -e '
    const fs = require("fs");
    const example = JSON.parse(fs.readFileSync("front/.libs/apptemplate/shared-modules.json.example", "utf8"));
    example.nestcommon = JSON.parse(process.env.NEST_MODULES);
    example.reactcommon = JSON.parse(process.env.REACT_MODULES);
    fs.writeFileSync("shared-modules.json", JSON.stringify(example, null, 2) + "\n");
  '
  ok "shared-modules.json written."
fi

info "Writing package.local.json overlays..."
if [[ -f front/package.local.json ]]; then
  ok "front/package.local.json already present — kept as-is."
else
  cat > front/package.local.json <<JSON
{
  "name": "${PROJECT_NAME}-front",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite --mode dev",
    "build": "tsc -b && vite build"
  }
}
JSON
  ok "front/package.local.json written."
fi
if [[ -f back/package.local.json ]]; then
  ok "back/package.local.json already present — kept as-is."
else
  cat > back/package.local.json <<JSON
{
  "name": "${PROJECT_NAME}-back",
  "version": "0.1.0"
}
JSON
  ok "back/package.local.json written."
fi

if [[ -f front/src/main.tsx && -f back/src/main.ts ]]; then
  ok "Base components already copied (apply-component-templates.mjs) — skipped, stays one-shot."
else
  info "Copying base UI components / minimal back skeleton (one-shot, never re-run after this)..."
  node scripts/apply-component-templates.mjs "${PROJECT_ROOT}" \
    --site-name "${SITE_NAME}" \
    --entity-name "${ENTITY_NAME}" \
    --contact-email "${CONTACT_EMAIL}" \
    --project-name "${PROJECT_NAME}"
  ok "Base components copied."
fi

info "Generating package.json (front + back) from package.base.json + package.local.json..."
( cd front && node .libs/apptemplate/scripts/build-package.mjs front )
( cd back && node .libs/apptemplate/scripts/build-package.mjs back )
ok "package.json generated for front and back."

if [[ "${VX_SKIP_INSTALL:-0}" == "1" ]]; then
  warn "VX_SKIP_INSTALL=1 — npm install skipped."
else
  info "Running npm install (front + back)..."
  if ! ( cd front && npm install ); then
    warn "front: npm install failed — fix manually with 'cd front && npm install'."
  fi
  if ! ( cd back && npm install ); then
    warn "back: npm install failed — fix manually with 'cd back && npm install'."
  fi
fi

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    info "Committing resumed scaffold changes..."
    git add -A
    git commit -q -m "Resume scaffold from AppTemplate"
    ok "Commit created."
  else
    ok "Nothing to commit — scaffold already committed."
  fi
else
  info "Creating initial commit..."
  git add -A
  git commit -q -m "Initial scaffold from AppTemplate"
  ok "Initial commit created."
fi

if [[ "${VX_SKIP_GITHUB:-0}" == "1" ]]; then
  warn "VX_SKIP_GITHUB=1 — GitHub repository creation skipped."
elif command -v gh >/dev/null 2>&1; then
  if gh repo view "${GITHUB_ORG}/${PROJECT_NAME}" >/dev/null 2>&1; then
    info "GitHub repository ${GITHUB_ORG}/${PROJECT_NAME} already exists — reusing it."
    if ! git remote get-url origin >/dev/null 2>&1; then
      git remote add origin "https://github.com/${GITHUB_ORG}/${PROJECT_NAME}.git"
    fi
    if git push -u origin main; then
      ok "Pushed to ${GITHUB_ORG}/${PROJECT_NAME}."
    else
      warn "git push failed — check the remote state manually."
    fi
  else
    info "Creating GitHub repository ${GITHUB_ORG}/${PROJECT_NAME} and pushing..."
    if gh repo create "${GITHUB_ORG}/${PROJECT_NAME}" --private --source=. --push; then
      ok "Pushed to ${GITHUB_ORG}/${PROJECT_NAME}."
    else
      warn "gh repo create failed — create the remote manually and run:"
      warn "  git remote add origin <url> && git push -u origin main"
    fi
  fi
else
  warn "gh CLI not found — create the remote manually and run:"
  warn "  git remote add origin <url> && git push -u origin main"
fi

cat <<SUMMARY

============================================================
  ${PROJECT_NAME} scaffolded at ${PROJECT_ROOT}

  Needed customizations before shipping:
  - back/src/config/defaultConfig.ts — add project-specific config defaults
  - back/.env.dev — Postgres, crypt keys (CRYPT_DB_MASTER_KEY,
    CRYPT_SESSION_PRIVATE_KEY) and REDIS_URL are pre-filled/generated; set
    ADMIN_WALLET to YOUR wallet address or you have no way to log in as admin
    (nothing can auto-fill this). Add other project-specific vars (API keys...)
    and a real back/.env for preprod/prod
  - front/.env.dev — pre-filled from the ports/name entered above; fill in
    VITE_REOWN_PROJECT_ID, VITE_TECH_TOKEN, VITE_BRAVE_API_KEY manually
    (VITE_TECH_TOKEN is seeded by the backend, not something this script can know)
  - front/src/theme.ts — replace the neutral placeholder color palette
  - shared-modules.json — add any nestcommon/reactcommon module your app needs
  - back/src/locales/custom.{en,fr}.json — replace placeholder landing/legal copy
  - front/src/components/pages/{Confidentiality,LegalMentions,UsageConditions}.tsx
    — fill in the actual legal text for ${ENTITY_NAME}
  - FEATURES.md — create and start tracking application capabilities
  - If running alongside other projects locally, double-check NODE_PORT (${NODE_PORT})
    and FRONT_PORT (${FRONT_PORT}) don't collide with an already-running app
============================================================
SUMMARY
