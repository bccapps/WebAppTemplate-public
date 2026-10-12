# Project Name

## Quick Start

All environments are managed through the unified `scripts/run.sh` launcher.

### Dev
```bash
./scripts/run.sh dev              # Infra (postgres + optional redis) + backend (watch) + frontend (vite)
./scripts/run.sh dev --infra-only # Only infrastructure containers
```
Ctrl+C stops everything (back, front, containers).

**Extra dev services (opt-in hook):** if the project has an executable
`scripts-local/dev-services.sh` (path overridable with `DEV_SERVICES_HOOK`), `run.sh dev` starts it
once back + front are ready — with `back/.env.dev` already loaded (`NODE_PORT`, …) — logs it to
`logs/dev-services.log` and stops it with the rest on Ctrl+C. Use it for any extra local process the
app needs in dev (worker, daemon, local agent…). No such file = no change. Example: a project can start
its local runner this way (URL derived from `NODE_PORT`, token from `back/.env.dev`). Keep it
dev-only: never put dev-only secrets in `back/.env`, which is shipped to production.

### Preprod
```bash
./scripts/run.sh preprod          # Build & start containerised preprod
```
Requires `back/.env.preprod`.

### Prod
```bash
./scripts/run.sh prod             # Runs deploy-remote.sh
```
Requires `back/.env` (production).

### Stop & Status
```bash
./scripts/run.sh stop dev         # Stop dev environment
./scripts/run.sh stop preprod     # Stop preprod environment
./scripts/run.sh stop all         # Stop everything
./scripts/run.sh status           # Show running services
```

## Environment Files

| File | Purpose |
|------|---------|
| `back/.env.dev` | Local development |
| `back/.env.preprod` | Pre-production (cloud DB + optional cloud Redis) |
| `back/.env` | Production |

### Required Environment Variables

| Category | Variables | Description |
|----------|-----------|-------------|
| **Project** | `PROJECT_NAME`, `NODE_PORT`, `FRONT_PORT` | Project identity and port mapping |
| **Database** | `DATABASE_ENGINE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`, `DB_PASSWORD` | Postgres connection (`DATABASE_ENGINE`: `selfhosted`, `cloud`, `supabase`, `neon`) |
| **DB options** | `DB_SSLMODE`, `DB_SSLROOTCERT`, `DB_POOLSIZE`, `TYPEORM_SYNC` | SSL, pool tuning, schema sync |
| **Security** | `ADMIN_TOKEN`, `CRYPT_DB_MASTER_KEY`, `CRYPT_DB_DERIVATION_SALT`, `CRYPT_SESSION_PRIVATE_KEY`, `CLIENT_ORIGINS` | Anonymous-mode admin key, encryption keys, CORS |
| **With the `user` module only** | `VITE_REOWN_PROJECT_ID`, `VITE_AUTH_CHAIN_POLICY`, `ADMIN_WALLET`, `TECH_TOKEN`, `JWT_SECRET` | Reown/WalletConnect auth, wallet admin, JWT (see `back/.env.example`) |
| **Deployment** | `FRONT_HOSTS`, `BACK_HOSTS`, `REMOTE_USER`, `REMOTE_SSH_PORT`, `SSH_KEY_FILE`, `REMOTE_CONTEXT_NAME`, `REMOTE_APP_DIR` | Remote Docker deployment |
| **Notifications** | `PROWL_API_KEY` | Push notifications (optional) |

## Needed Customizations

- [ ] Update `back/src/config/defaultConfig.ts` with project-specific defaults
- [ ] Configure `back/.env` and `back/.env.dev`
- [ ] Update `FEATURES.md` with project capabilities

## Dockerfiles

| File | Purpose |
|------|---------|
| `back/Dockerfile` | Lean, cloud-ready (multi-stage, no PM2, env at runtime) |
| `back/Dockerfile.selfhosted` | Self-hosted / VPS (PM2, baked .env) |

## Common dependency baseline (front)

`front/package.base.json` is the single source for any dependency more than
one consuming app needs. A dependency belongs in `package.local.json`
(project-specific overlay) ONLY when it serves a feature genuinely unique to
that app. Before adding a new dependency to a project's `package.local.json`,
check whether another app on the template already carries the same package;
if so, it belongs in the base instead, so all apps track one version instead
of drifting apart silently.

Web3 / auth dependencies (`wagmi`, `viem`, `@reown/*`, `@openfort/openfort-js`, `@tanstack/react-query`,
`@base-org/account`, and on the back `bip322-js`, `jsonwebtoken`, `otplib`, `qrcode`, `tweetnacl`, `viem`,
`@nestjs/throttler`) are NOT in this baseline anymore: they live in the `user` module's `package.fragment.json`
(react and nest) and are merged by `build-package.mjs` only when `user` is listed in `shared-modules.json`.
The version pins and the rationale for the `@wagmi/core` overrides are documented in `reactcommon/user/README.md`.

## User management (optional)

User management is enabled **only by listing `user` in `shared-modules.json`** (no environment variable).

- **Without `user`** (public default: `common`, `database`, optionally `voice`): anonymous mode. No login button, no web3 dependency
  in the bundle. The admin area (`/admin/*`) is protected by the `ADMIN_TOKEN` back env variable (>= 32 random chars,
  `openssl rand -hex 32`; empty = admin disabled). The front asks for the key once, keeps it in `sessionStorage` and sends it as
  `Authorization: Bearer`; a logout button appears in the header when it is set. `GET /api/v1/admin-session` returns 401 without a valid token.
- **With `user`** (and its private dependencies `commerce`, `infra`, `oauth`): full accounts, Reown login, wallet-based admin
  (`ADMIN_WALLET`), `/admin/user`. Nothing else to configure besides the usual `user` variables.

How it works: every shared module may expose a plugin (`plugin.ts` on the back, `plugin.tsx` on the front). `link-shared.mjs`
generates `back/src/modules_shared/plugins.generated.ts`; `front/src/plugins.ts` uses `import.meta.glob`. `AppModule.ts`, `App.tsx`,
`Router.tsx`, `Header.tsx` and `AdminSidebar.tsx` read the plugins, so adding a module needs no edit there. The npm dependencies of a
module (e.g. wagmi/Reown for `user`) live in its `package.fragment.json`, merged by `build-package.mjs` when the module is linked.

## Architecture

- **Monorepo**: `front/` (React + Vite + TypeScript) and `back/` (NestJS + TypeORM + Postgres)
- **Shared libraries**: modules from `.libs/vx-public` (MIT: common, database, voice) and `.libs/vx-private` (user, commerce, infra, ...),
  with `.libs/apptemplate` as alias of the template (legacy layout: `nestcommon`, `reactcommon`) — symlinked into `modules_shared/` by `link-shared.mjs`
- **Module-first**: business domains as dedicated modules, mirrored between front and back
- **Configuration**: seeded to DB via `defaultConfig.ts` (project-specific) + `configSchema.ts` (module-level)
- **Internationalization**: `back/src/locales/` — `common.*.json` + `custom.*.json`

## DB SSL Connection

For cloud DB providers with self-signed certificates, place the certificate at `back/<cert-file>` and set `DB_SSLROOTCERT=<cert-file>` in your `.env`.

## Utilities

### URL-encode a complex password
```bash
python3 -c "from urllib.parse import quote; import sys; print(quote(sys.argv[1], safe=''))" "PASSWORD"
```

### Extract and restore a table
```bash
# Export
pg_dump "$DATABASE_URL" --data-only --table=<table_name> --column-insert --no-owner > table_dump.sql
# Import
psql "$TARGET_DATABASE_URL" < table_dump.sql
```

### Enable Row Level Security (RLS) on all tables
```sql
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', r.table_schema, r.table_name);
  END LOOP;
END;
$$;
```

### Copy a table record between environments
Export from the source DB, then import into the target. Pass credentials via
environment (`PGPASSWORD`, `DATABASE_URL`) — never hardcode them in commands or commit them.
```bash
# Export (source)
PGPASSWORD="$SRC_DB_PASSWORD" psql -h "$SRC_HOST" -p "$SRC_PORT" -U "$SRC_USER" -d "$SRC_DB" \
  -c "\copy (SELECT ... FROM <table> WHERE <filter>) TO 'export.csv' WITH CSV HEADER"

# Import (target) — copy export.csv to the target host / container, then:
PGPASSWORD="$DST_DB_PASSWORD" psql -h "$DST_HOST" -p "$DST_PORT" -U "$DST_USER" -d "$DST_DB" \
  -c "\copy <table> (...) FROM '/tmp/export.csv' WITH CSV HEADER"
```