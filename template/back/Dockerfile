# Shared back Dockerfile (canonical, TK-based). Multi-stage NestJS build with
# locale collection and a writable runtime dir for the unprivileged user.
# Local tarball deps (e.g. a dydx *.tgz referenced via file: in package.json)
# are copied explicitly alongside the manifests — see the caching note below.
#
# Layer caching strategy:
#   prod-deps — npm ci --omit=dev  (cached until package*.json / *.tgz change)
#   builder   — npm ci + tsc build (npm ci cached; tsc re-runs on source change)
#   runtime   — prod node_modules first, dist last (see the runtime stage)
#
# NEVER reintroduce `RUN --mount=type=bind,source=.` around npm ci: BuildKit folds the
# mounted context into the step's cache key, so mounting the WHOLE context makes every
# source edit invalidate npm ci. Measured effect: one 739 MB cache record per deploy,
# used exactly once (several per project), and ~180 s added
# to every remote build. A plain COPY of the manifests + tarballs keeps the key stable.

# ---- Production deps (separate stage — avoids npm prune pass) ----
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
# npm major MUST match the machine that WRITES the lock: node 22 ships npm 10, the control
# machine runs node 23+ (npm 11). npm 10 rejects an npm 11 lock — it insists on also
# installing the optional peer `chokidar@^3.5.2` declared by the @angular-devkit/core
# nested under @nestjs/schematics, a peer npm 11 deliberately skips — and dies with:
#     npm error Missing: chokidar@3.6.0 from lock file
# (one project's back, 2026-09-27; reproduced outside Docker with npm 10.9.9 vs 11.19.0 —
# front and runner locks happen to satisfy both majors, only back diverges).
# npm 11 accepts locks written by BOTH majors, npm 10 only its own: the image follows the
# machine that generates the lock, rather than asking every dev to downgrade.
# Keep in sync with the prod-deps stage emitted by scripts/deploy-full.sh (prebuilt path).
RUN npm install -g npm@11
# *.tgz: local tarball deps referenced via `file:` in package.json. BuildKit tolerates a
# wildcard matching nothing, so this is a no-op for projects without tarball deps.
COPY package*.json *.tgz ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- Builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Same npm major as prod-deps below — the `npm ci` there validates the same lock.
# (npm 11 also runs the builder's own `npm ci` on the write path: install of dev deps.)
RUN npm install -g npm@11

ARG NESTCLI_VERSION=11.0.16
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @nestjs/cli@${NESTCLI_VERSION} --omit=dev

# Copy package manifests (and local tarballs) first — npm ci layer is only invalidated
# when they change, not on every source edit.
COPY package*.json *.tgz ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Source copy only invalidates the TypeScript build, not npm install.
COPY . .
RUN npm run build
# Strip build-time-only artefacts: nothing loads them at runtime (source-map-support is not
# imported and the CMD carries no --enable-source-maps), and they are ~55% of dist's weight.
# Done here rather than via tsconfig so `nest start --debug` keeps its sourcemaps locally.
RUN find dist \( -name '*.js.map' -o -name '*.d.ts' \) -delete

# Collect locale JSONs (tsc doesn't copy them into dist)
RUN mkdir -p /locales/app && \
    cp -r src/locales/* /locales/app/ && \
    mkdir -p /locales/modules && \
    find -L src/modules src/modules_shared -path '*/locales/*.json' 2>/dev/null | \
    while IFS= read -r f; do \
      mkdir -p "/locales/modules/$(dirname "$f")"; \
      cp "$f" "/locales/modules/$f"; \
    done || true

# Sentinel so the optional *.crt COPY below never fails when no cert exists
RUN touch /app/.no-cert.crt

# ---- Runtime ----
# glibc-based (not alpine/musl): some npm deps ship prebuilt Linux .so binaries linked
# against glibc (e.g. zklighter-sdk's signer) that musl can't load even with the gcompat
# shim (ELF relocation types glibc-built binaries use aren't supported by musl's ld.so).
# All 3 stages must share the same libc so node_modules installed in prod-deps/builder
# match what the runtime actually loads.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# wget: used by the compose healthcheck (CMD-SHELL wget ...). Alpine's busybox has it
# built in; Debian slim images don't ship it by default.
# ca-certificates: TLS verification for outbound HTTPS calls made by native Go binaries
# (e.g. zklighter-sdk's signer) — Debian slim doesn't ship the CA bundle either, so those
# calls fail with "x509: certificate signed by unknown authority" without it.
# postgresql-client: pg_isready/psql, used by migrate-db.sh to wait for the DB and check
# whether the schema is empty before running TypeORM migrations inside this same image.
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates postgresql-client && \
    rm -rf /var/lib/apt/lists/*

# Layers are ordered from most stable to most volatile. Everything below an invalidated
# layer is rebuilt, re-exported and re-unpacked, so node_modules (739 MB, changes only
# when package*.json does) MUST come before dist (17 MB, changes on every deploy).
# The reverse order cost ~25 s of COPY + ~95 s of export/unpack on every single build.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/package.json ./
# SSL certs (sentinel ensures at least one file matches the glob)
COPY --chown=node:node --from=builder /app/*.crt ./
RUN rm -f .no-cert.crt

# Writable runtime dir for the unprivileged user (e.g. backtest cache / shared data).
# Override per project (e.g. "shared") via --build-arg APP_RUNTIME_DIR=...
ARG APP_RUNTIME_DIR=.cache
RUN mkdir -p "/app/${APP_RUNTIME_DIR}" && chown -R node:node "/app/${APP_RUNTIME_DIR}"

COPY --chown=node:node --from=builder /locales/app ./src/locales
COPY --chown=node:node --from=builder /locales/modules/src/ ./src/
COPY --chown=node:node --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/main.js"]
