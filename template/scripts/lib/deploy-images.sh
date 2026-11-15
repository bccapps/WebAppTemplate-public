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
# Registry mode of deploy-full.sh. SOURCED by it (bash 3.2 compatible: no associative array, no mapfile), after the logging
# helpers and lib/deploy-versions.sh; everything else it needs (BUILD_CONTEXT_DIR, PROJECT_NAME, DEPLOY_TARGET, IS_CLOUD_FRONT,
# NO_CACHE_FLAG, DEPLOY_REVISION, ensure_docker_context, resolve_key_path, parse_host_entry, sanitize_identifier, dv_*) is
# resolved at call time.
#
# WHY. Without a registry every host builds its own image from an uploaded context (N hosts = N builds), and a rollback is only
# the `:previous` tag left on each host. In registry mode the images are built ONCE, pushed under an immutable tag, and every
# host only pulls that tag: what was built (and tested on preprod) is what runs on prod, and a rollback is a deploy of an older tag.
#
# OPT-IN. Registry mode is on when DEPLOY_REGISTRY is set (back/.env or the caller's environment). Unset: byte-for-byte the
# historical behaviour (build on each target through its Docker context); --build / --push are then refused.
#
# Settings (back/.env or environment; the caller's environment wins over the file):
#   DEPLOY_REGISTRY=<host[:port]>        name the HOSTS pull from (e.g. registry.example.com)
#   DEPLOY_REGISTRY_PUSH=<host[:port]>   name the BUILDER pushes to (default: DEPLOY_REGISTRY); `localhost:5000` when the builder
#                                        is the registry machine itself (no TLS, no round trip through the reverse proxy)
#   DEPLOY_BUILDER=remote|local          where the image is assembled (default remote)
#     remote  a Docker daemon reached through an SSH context (DEPLOY_BUILDER_HOST=[user@]host, DEPLOY_BUILDER_SSH_PORT,
#             DEPLOY_BUILDER_SSH_KEY_FILE; defaults: REMOTE_USER, REMOTE_SSH_PORT, SSH_KEY_FILE). It must be linux/amd64-native
#             and logged in to the registry (docker login, done once on that machine): this machine never holds a registry secret.
#     local   this machine's daemon (`buildx --platform ${DEPLOY_PLATFORM:-linux/amd64}`); the push uses THIS machine's docker login.
#   DEPLOY_IMAGE_TAG / --tag=<tag>       tag to build or to deploy (default: git short sha, `-dirty` + timestamp when the tree is dirty)
#
# Phases (deploy-full.sh flags; none = all three): --build (compile + build the image), --push (implies --build, pushes it),
# --deploy (pull on every host and switch). `--deploy --tag=<t>` ships an already pushed tag and builds nothing.
#
# Image names: <DEPLOY_REGISTRY>/<PROJECT_NAME>/<service>:<tag>, with <service> = every compose service that has a `build:` and no
# `profiles:` (back, front). The back image does not depend on the environment (the same one goes preprod -> prod); the front has
# its VITE_* values compiled in, so its tag carries the environment (`<tag>-prod`).
# On each host the pulled image is tagged with the name the compose file uses (`<PROJECT_NAME>_back:latest`, `<project>-front:latest`),
# so the maintenance window, the `:previous` tag and the rollbacks of lib/deploy-versions.sh work unchanged.
#
# Progress marker (parsed by Agent Hub, exact string):
#   ==> [IMAGE:<PROJECT_NAME>] service=<s> tag=<t> digest=<sha256:…|unknown> host=<h>|builder=<h>

DI_FLAG_BUILD=0
DI_FLAG_PUSH=0
DI_FLAG_DEPLOY=0
DI_ACTIVE=0
DI_BUILD=1      # compile + stage the build context on this machine (always, outside registry mode)
DI_PUSH=0
DI_DEPLOY=1
DI_TAG=""
DI_CONFIG_JSON=""
DI_BUILDER_SSH_TARGET=""
DI_BUILDER_SSH_OPTS=()
DI_BUILDER_DOCKER_SSH=""
DI_BUILDER_CONTEXT=""
DI_LAST_REF=""
DI_LAST_DIGEST=""

# Variables the caller's environment (Ansible, Agent Hub, a shell) may set and that back/.env, sourced by deploy-full.sh,
# must NOT silently override: snapshot before the source, restore after.
DI_CALLER_VARS="DEPLOY_REGISTRY DEPLOY_REGISTRY_PUSH DEPLOY_BUILDER DEPLOY_BUILDER_HOST DEPLOY_BUILDER_SSH_PORT DEPLOY_BUILDER_SSH_KEY_FILE DEPLOY_IMAGE_TAG DEPLOY_PLATFORM DEPLOY_BACK_HOSTS DEPLOY_FRONT_HOSTS DEPLOY_MANAGE_UFW"

di_snapshot_caller_env() {
  local v
  for v in ${DI_CALLER_VARS}; do
    if [[ -n "${!v:-}" ]]; then
      printf -v "DI_CALLER_${v}" '%s' "${!v}"
    fi
  done
}

di_restore_caller_env() {
  local v c
  for v in ${DI_CALLER_VARS}; do
    c="DI_CALLER_${v}"
    if [[ -n "${!c:-}" ]]; then
      printf -v "${v}" '%s' "${!c}"
      export "${v}"
    fi
  done
}

# Command-line flags (called from the argument loop of deploy-full.sh).
di_parse_flag() {
  case "$1" in
    --build) DI_FLAG_BUILD=1 ;;
    --push) DI_FLAG_PUSH=1 ;;
    --deploy) DI_FLAG_DEPLOY=1 ;;
    --tag=*) DEPLOY_IMAGE_TAG="${1#*=}" ;;
    --builder=*) DEPLOY_BUILDER="${1#*=}" ;;
  esac
}

# Settles DI_ACTIVE / DI_BUILD / DI_PUSH / DI_DEPLOY once the env is sourced. Exits on an impossible combination, before any host
# is touched.
di_resolve_phases() {
  DI_ACTIVE=0
  [[ -n "${DEPLOY_REGISTRY:-}" ]] && DI_ACTIVE=1
  if [[ "${DI_ACTIVE}" -eq 0 ]]; then
    if [[ "${DI_FLAG_BUILD}${DI_FLAG_PUSH}" != "00" ]]; then
      err "--build / --push need registry mode: set DEPLOY_REGISTRY (back/.env or environment)."
      exit 1
    fi
    if [[ -n "${DEPLOY_IMAGE_TAG:-}" ]]; then
      err "--tag needs registry mode: set DEPLOY_REGISTRY (back/.env or environment)."
      exit 1
    fi
    DI_BUILD=1; DI_PUSH=0; DI_DEPLOY=1
    return 0
  fi
  if [[ "${DI_FLAG_BUILD}${DI_FLAG_PUSH}${DI_FLAG_DEPLOY}" == "000" ]]; then
    DI_BUILD=1; DI_PUSH=1; DI_DEPLOY=1
  else
    DI_BUILD=0; DI_PUSH=0; DI_DEPLOY=0
    if [[ "${DI_FLAG_BUILD}" == "1" || "${DI_FLAG_PUSH}" == "1" ]]; then DI_BUILD=1; fi
    [[ "${DI_FLAG_PUSH}" == "1" ]] && DI_PUSH=1
    [[ "${DI_FLAG_DEPLOY}" == "1" ]] && DI_DEPLOY=1
  fi
  case "${DEPLOY_BUILDER:-remote}" in
    remote|local) ;;
    *) err "DEPLOY_BUILDER='${DEPLOY_BUILDER}' is not valid (expected remote|local)."; exit 1 ;;
  esac
  if [[ "${DI_BUILD}" -eq 0 && -z "${DEPLOY_IMAGE_TAG:-}" ]]; then
    err "--deploy without --build needs the tag to ship: --tag=<tag> (DEPLOY_IMAGE_TAG)."
    exit 1
  fi
  if [[ "${DI_BUILD}" -eq 1 && "${DEPLOY_BUILDER:-remote}" == "remote" && -z "${DEPLOY_BUILDER_HOST:-}" ]]; then
    err "DEPLOY_BUILDER=remote needs DEPLOY_BUILDER_HOST ([user@]host of the Docker daemon that builds); or DEPLOY_BUILDER=local."
    exit 1
  fi
  if [[ "${DI_BUILD}" -eq 1 && "${DI_DEPLOY}" -eq 0 && "${DI_PUSH}" -eq 0 ]]; then
    info "Registry mode: build only (--build) — the image is not pushed and no host is touched."
  fi
}

# Tag of this run: --tag / DEPLOY_IMAGE_TAG, else the revision. A dirty tree (or an unknown revision) gets a timestamp: such an
# image must never overwrite an immutable tag.
di_compute_tag() {
  local t="${DEPLOY_IMAGE_TAG:-}"
  if [[ -z "${t}" ]]; then
    t="$(dv_compute_revision)"
    case "${t}" in
      *-dirty|unknown) t="${t}-$(date -u +%Y%m%d%H%M%S)" ;;
    esac
  fi
  DI_TAG="$(printf '%s' "${t}" | tr -c 'A-Za-z0-9_.-' '-')"
  if [[ -z "${DI_TAG}" || "${#DI_TAG}" -gt 120 ]]; then
    err "Image tag '${t}' is empty or too long (max 120 characters of A-Za-z0-9_.-)."
    exit 1
  fi
}

# Tag of one service: the front carries its environment (VITE_* values are compiled in).
di_tag_for() {
  if [[ "$1" == "front" ]]; then
    printf '%s-%s' "${DI_TAG}" "$(dv_environment_name)"
  else
    printf '%s' "${DI_TAG}"
  fi
}

di_ref() { printf '%s/%s/%s:%s' "$1" "${PROJECT_NAME}" "$2" "$3"; }

# ---------------------------------------------------------------------------
# Compose model (what to build, with which context / Dockerfile / args)
# ---------------------------------------------------------------------------
# Resolves the staged compose file once (interpolation needs the env already exported / the root .env of the context).
di_load_compose_model() {
  DI_CONFIG_JSON="${BUILD_CONTEXT_DIR}/.compose-model.json"
  local raw="${BUILD_CONTEXT_DIR}/.compose-config.err"
  # `compose config` inlines env_file values: only the build model (build / image / profiles per service) is kept, never the
  # environment of the services, which carries the secrets.
  if ! docker compose --project-directory "${BUILD_CONTEXT_DIR}" --project-name "${COMPOSE_PROJECT_NAME}" \
      config --format json 2>"${raw}" \
    | python3 -c '
import json, sys
cfg = json.load(sys.stdin)
keep = {}
for name, svc in (cfg.get("services") or {}).items():
    keep[name] = {k: svc[k] for k in ("build", "image", "profiles") if k in svc}
json.dump({"services": keep}, sys.stdout)
' >"${DI_CONFIG_JSON}"; then
    err "docker compose config failed on the staged compose file:"
    sed 's/^/    /' "${raw}" >&2
    exit 1
  fi
  chmod 600 "${DI_CONFIG_JSON}"
}

# di_cfg <service> <field>: has_build (1|0) | context | dockerfile | image | args (K=V lines). Prints nothing for an unknown field.
di_cfg() {
  python3 - "${DI_CONFIG_JSON}" "$1" "$2" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
svc = (cfg.get("services") or {}).get(sys.argv[2])
field = sys.argv[3]
if svc is None:
    print(0 if field == "has_build" else "", end="")
    sys.exit(0)
build = svc.get("build")
if isinstance(build, str):
    build = {"context": build}
if field == "has_build":
    print(1 if build and not svc.get("profiles") else 0)
elif field == "context":
    print((build or {}).get("context", ""))
elif field == "dockerfile":
    b = build or {}
    df = b.get("dockerfile") or "Dockerfile"
    print(df if os.path.isabs(df) else os.path.join(b.get("context", "."), df))
elif field == "image":
    print(svc.get("image", ""))
elif field == "args":
    for k, v in ((build or {}).get("args") or {}).items():
        if v is not None:
            print("%s=%s" % (k, v))
PY
}

# Services of this run that live in the registry: back (unless --target=front), front container (unless --target=back or Pages).
di_services() {
  local s
  for s in back front; do
    [[ "${s}" == "back" && "${DEPLOY_TARGET}" == "front" ]] && continue
    [[ "${s}" == "front" && ( "${DEPLOY_TARGET}" == "back" || "${IS_CLOUD_FRONT}" -eq 1 ) ]] && continue
    [[ "$(di_cfg "${s}" has_build)" == "1" ]] || continue
    printf '%s\n' "${s}"
  done
}

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
di_builder_prepare() {
  [[ "${DEPLOY_BUILDER:-remote}" == "remote" ]] || return 0
  local entry="${DEPLOY_BUILDER_HOST}" user host port key
  read -r user host <<<"$(parse_host_entry "${entry}" "${REMOTE_USER:-ubuntu}")"
  port="${DEPLOY_BUILDER_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
  key="$(resolve_key_path "${DEPLOY_BUILDER_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}")"
  DI_BUILDER_SSH_TARGET="${user}@${host}"
  DI_BUILDER_SSH_OPTS=(-p "${port}")
  DI_BUILDER_DOCKER_SSH="ssh -p ${port}"
  if [[ -n "${key}" ]]; then
    DI_BUILDER_SSH_OPTS+=(-i "${key}")
    DI_BUILDER_DOCKER_SSH="ssh -i ${key} -p ${port}"
  fi
  DI_BUILDER_CONTEXT="$(build_context_name "${REMOTE_CONTEXT_NAME:-builder}-builder" "${host}")"
  echo "==> [BUILDER:${host}] Testing SSH connectivity"
  ssh "${DI_BUILDER_SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${DI_BUILDER_SSH_TARGET}" "echo SSH_OK" >/dev/null
  ensure_docker_context "${DI_BUILDER_CONTEXT}" "${DI_BUILDER_SSH_TARGET}" "${port}"
}

di_builder_label() {
  if [[ "${DEPLOY_BUILDER:-remote}" == "remote" ]]; then printf '%s' "${DI_BUILDER_SSH_TARGET#*@}"; else printf 'local'; fi
}

di_bdocker() { DOCKER_SSH_COMMAND="${DI_BUILDER_DOCKER_SSH}" docker --context "${DI_BUILDER_CONTEXT}" "$@"; }
di_bssh()    { ssh "${DI_BUILDER_SSH_OPTS[@]}" "${DI_BUILDER_SSH_TARGET}" "$@"; }

# Short sha of a shared library mount (vx-public / vx-private), empty when absent.
di_lib_rev() {
  local lib="$1" side rev
  for side in front back; do
    rev="$(git -C "./${side}/.libs/${lib}" rev-parse --short HEAD 2>/dev/null || true)"
    if [[ -n "${rev}" ]]; then printf '%s' "${rev}"; return 0; fi
  done
}

# ---------------------------------------------------------------------------
# Build + push (once per run, before any host is touched)
# ---------------------------------------------------------------------------
# An image that goes to a registry must never carry an env file (the staged contexts hold back/.env, front/.env with deploy tokens):
# the context's .dockerignore must be a whitelist (`*` first, the prebuilt variant) or exclude `.env*` itself.
di_context_is_safe() {
  local ig="$1/.dockerignore"
  [[ -f "${ig}" ]] || return 1
  grep -Eq '^\*[[:space:]]*$' "${ig}" && return 0
  grep -Eq '^(\*\*/)?\.env[*.A-Za-z]*[[:space:]]*$' "${ig}"
}

di_build_service() {
  local svc="$1" ctx df tag push_ref arg lib_public lib_private
  ctx="$(di_cfg "${svc}" context)"
  df="$(di_cfg "${svc}" dockerfile)"
  if ! di_context_is_safe "${ctx}"; then
    err "Refusing to build ${svc} for a registry: ${ctx}/.dockerignore neither whitelists the context nor excludes .env files (the local build fell back to a remote-style build?). Nothing was built."
    exit 1
  fi
  tag="$(di_tag_for "${svc}")"
  push_ref="$(di_ref "${DEPLOY_REGISTRY_PUSH:-${DEPLOY_REGISTRY}}" "${svc}" "${tag}")"
  lib_public="$(di_lib_rev vx-public)"
  lib_private="$(di_lib_rev vx-private)"

  local -a args=()
  while IFS= read -r arg; do
    [[ -n "${arg}" ]] && args+=(--build-arg "${arg}")
  done < <(di_cfg "${svc}" args)
  args+=(--label "org.opencontainers.image.revision=${DEPLOY_REVISION}")
  args+=(--label "org.opencontainers.image.title=${PROJECT_NAME}-${svc}")
  [[ -n "${lib_public}" ]] && args+=(--label "vx.public=${lib_public}")
  [[ -n "${lib_private}" ]] && args+=(--label "vx.private=${lib_private}")
  args+=(--label "vx.environment=$(dv_environment_name)")

  local t0
  t0="$(dt_now)"
  echo "==> [BUILDER:$(di_builder_label)] Building ${svc} → ${push_ref}"
  if [[ "${DEPLOY_BUILDER:-remote}" == "remote" ]]; then
    # No provenance/SBOM attestation: BuildKit would push an OCI INDEX (image + attestation) and the registry's garbage collection
    # (registry:2) deletes the children of such an index, leaving a tag that cannot be pulled. A plain manifest is GC-safe.
    BUILDX_NO_DEFAULT_ATTESTATIONS=1 di_bdocker build --pull ${NO_CACHE_FLAG} -f "${df}" "${args[@]}" -t "${push_ref}" "${ctx}" \
      || { err "Image build failed for ${svc} — nothing was pushed, no host was touched."; exit 1; }
    dt_record "image ${svc}: build on the builder" "${t0}"
    if [[ "${DI_PUSH}" -eq 1 ]]; then
      t0="$(dt_now)"
      echo "==> [BUILDER:$(di_builder_label)] Pushing ${push_ref}"
      di_bssh "docker push '${push_ref}'" \
        || { err "Push of ${push_ref} failed (is the builder logged in to the registry? the vhost body size limit?) — no host was touched."; exit 1; }
      dt_record "image ${svc}: push" "${t0}"
      DI_LAST_DIGEST="$(di_bssh "docker image inspect --format '{{index .RepoDigests 0}}' '${push_ref}'" 2>/dev/null | sed -n 's/.*@//p' | head -n 1 || true)"
    fi
  else
    local mode="--load"
    [[ "${DI_PUSH}" -eq 1 ]] && mode="--push"
    docker buildx build --provenance=false --sbom=false --pull ${NO_CACHE_FLAG} --platform "${DEPLOY_PLATFORM:-linux/amd64}" -f "${df}" "${args[@]}" \
      -t "${push_ref}" "${mode}" "${ctx}" \
      || { err "Local image build/push failed for ${svc} (Docker running? docker login to ${DEPLOY_REGISTRY_PUSH:-${DEPLOY_REGISTRY}} done?) — no host was touched."; exit 1; }
    dt_record "image ${svc}: build$([[ "${DI_PUSH}" -eq 1 ]] && printf ' + push') (local buildx)" "${t0}"
    DI_LAST_DIGEST=""
  fi
  echo "==> [IMAGE:${PROJECT_NAME}] service=${svc} tag=${tag} digest=${DI_LAST_DIGEST:-unknown} builder=$(di_builder_label)"
}

di_build_all() {
  local svc
  di_load_compose_model
  di_builder_prepare
  for svc in $(di_services); do
    di_build_service "${svc}"
  done
}

# ---------------------------------------------------------------------------
# Deploy side (per host; the DV_* host is already positioned by dv_use_host)
# ---------------------------------------------------------------------------
# Name the compose file gives the image of a service on THIS host (so `up -d` finds it and dv_tag_previous / rollbacks keep working).
di_local_image() {
  local svc="$1" image
  image="$(di_cfg "${svc}" image)"
  if [[ -n "${image}" ]]; then
    printf '%s' "${image%:*}"
  else
    printf '%s-%s' "${DV_PROJECT}" "${svc}"
  fi
}

# Pulls the pushed tag of <service> on the current host (with the HOST's own registry login, never this machine's) and tags it
# as the compose image. Returns 1 on failure; the caller stops BEFORE the maintenance window and restores `latest`.
di_pull_and_tag() {
  local svc="$1" image tag ref t0
  [[ -n "${DI_CONFIG_JSON}" ]] || di_load_compose_model
  image="$(di_local_image "${svc}")"
  tag="$(di_tag_for "${svc}")"
  ref="$(di_ref "${DEPLOY_REGISTRY}" "${svc}" "${tag}")"
  t0="$(dt_now)"
  echo "==> [$(dv_tag)] Pulling ${ref}"
  if ! dv_ssh "docker pull '${ref}'"; then
    err "[$(dv_tag)] Pull of ${ref} failed: tag not pushed, registry unreachable from this host, or this host is not logged in to ${DEPLOY_REGISTRY} (docker login as the deploy user)."
    return 1
  fi
  dv_docker tag "${ref}" "${image}:latest" || { err "[$(dv_tag)] Could not tag ${ref} as ${image}:latest"; return 1; }
  DI_LAST_REF="${ref}"
  DI_LAST_DIGEST="$(dv_ssh "docker image inspect --format '{{index .RepoDigests 0}}' '${ref}'" 2>/dev/null | sed -n 's/.*@//p' | head -n 1 || true)"
  dt_record "$(dv_tag) image ${svc}: pull" "${t0}"
  echo "==> [IMAGE:${PROJECT_NAME}] service=${svc} tag=${tag} digest=${DI_LAST_DIGEST:-unknown} host=${DV_HOST}"
}
