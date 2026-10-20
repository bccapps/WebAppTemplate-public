# Project Name

## Quick Start

All environments are managed through the unified `scripts/run.sh` launcher.

### Dev
```bash
./scripts/run.sh dev              # Infra (postgres + optional redis) + backend (watch) + frontend (vite)
./scripts/run.sh dev --infra-only # Only infrastructure containers
```
With `DB_ENGINE=sqlite` no container is started: the database is a file read by the back
process; Docker is used only when `REDIS_URL` is set, and `--infra-only` then has nothing to start (it says so).
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
./scripts/run.sh preprod          # Deploys through deploy-full.sh (back/.env.preprod + front/.env.preprod)
```
Requires `back/.env.preprod`.

### Prod
```bash
./scripts/run.sh prod             # Deploys through deploy-full.sh (back/.env + front/.env)
```
Requires `back/.env` (production).

### Deploy options, versions and rollback

`preprod` and `prod` run `update_common.sh` (library commit + push) first, then `deploy-full.sh`. Flags:

| Flag | Effect |
|---|---|
| `--no-update-common` (or `SKIP_UPDATE_COMMON=1`) | Skip the library sync (used by Agent Hub's deploy button; never forwarded to `deploy-full.sh`) |
| `--target=all\|back\|front` | What to deploy |
| `--migrate` | Run DB migrations first (Postgres; refused for SQLite) |
| `--no-auto-rollback` | On failure keep the failed state (exit 1, maintenance stays ON) instead of rolling back |

Every deploy keeps the previous version on each host, so it can be undone:

- **Revision**: `DEPLOY_REVISION` (env var, else `git rev-parse --short HEAD`, plus `-dirty` when the work tree has changes) is injected into the back env and returned as `revision` by `GET /api/v1/health` (`null` when the back was not deployed by the script).
- **Images**: before building, `<image>:latest` is tagged `:previous` (back image `${PROJECT_NAME}_back`, front image `<compose project>-front`); the remote `.env` is copied to `.env.previous`; after a successful switch `REMOTE_APP_DIR/.deploy/current.json` (`revision`, `environment`, `date`, `dbBackup`) replaces `previous.json`.
- **Database backup**, taken once the old back is stopped and before `up` (no writer): **SQLite** → a copy of the file in the volume, `/data/backups/<project>-pre-<revision>-<UTC time>.db` (last 5 kept); **self-hosted Postgres** → `./backups/<project>_pre-<revision>_<time>.sql.gz`, only with `--migrate` or `DB_SCHEMA_MODE=sync` (the dump is taken by the deploy, i.e. after `run.sh`'s migration step: use `./scripts/backup-db.sh` first for a pre-migration copy; no automatic restore, the restore command is printed); **cloud DB** (supabase, neon...) → warning only. A failed backup aborts the deploy (and rolls back).
- **Automatic rollback** (default): when the new back is not healthy within 180 s, or any command fails after maintenance mode was enabled, every host switched in this run goes back (`previous` → `latest`, `.env.previous`, `up -d` without build, wait healthy, maintenance off). The SQLite backup of this run is restored too (the new back never served traffic). A front container that does not stay up rolls back the front hosts only (the healthy new back is kept, no data restore). Without a previous image (first deploy) there is nothing to roll back to.
- **Manual rollback**: `./scripts/run.sh rollback <preprod|prod> [--restore-db] [--target=all|back|front]` swaps `latest` ↔ `previous`, `.env` ↔ `.env.previous` and `current.json` ↔ `previous.json` (running it twice rolls forward again), with maintenance on/off around the restart. It never syncs libraries, builds or updates submodules, and refuses (exit 1, nothing changed) when a host has no `:previous` image. `--restore-db` (SQLite only) first restores the backup recorded in the current `current.json` (writes made since that deploy are lost); with Postgres/cloud it only warns. The front on Cloudflare Pages is not handled (use the Cloudflare dashboard).

**back-worker and the schema.** Only `back` manages the database schema: in both compose files `back-worker` runs with `DB_SCHEMA_MODE: manual` (no synchronize, no migrations; this overrides `DB_SCHEMA_MODE` of `back/.env`, a per-connection `<PREFIX>SCHEMA_MODE` of another connection is NOT overridden) and `depends_on: back: condition: service_healthy`. Two processes running the schema sync together on one SQLite file lock each other (`database is locked`, observed in production) or see a half-applied table rebuild. `deploy-full.sh` therefore starts the other services, waits for `back` to be healthy, THEN starts `back-worker` (`up -d --no-build --no-deps back-worker`, marker `==> [BACK:<host>] Starting back-worker (after back is healthy)`), and only then lifts maintenance mode, in the normal switch and in the rollback alike. A worker that fails to start after the switch takes the usual failure path (automatic rollback, exit 3/4).

**`BACK_WORKER=on|off`** (`back/.env`, default `on`; also `true|false|1|0`, anything else is refused before any host is touched). With `off` there is no `back-worker`: it is not built nor started, an existing container is stopped and removed by the switch (`==> [BACK:<host>] back-worker disabled (BACK_WORKER=off): removed if present`), and `back` becomes a single process with `NODE_ROLE=all` (API + background work: crons gated on `InstanceRoleService.isWorker()` keep running). The compose files read `NODE_ROLE: ${BACK_NODE_ROLE:-api}`; `deploy-full.sh` exports `BACK_NODE_ROLE=all` into the environment of every `docker compose` call (rollbacks included, from the local `back/.env`) and leaves it unset otherwise.

Exit codes of a deploy: `0` ok · `3` failed, previous version restored · `4` failed, rollback failed or impossible (maintenance may still be ON) · `1` any other failure (before the switch, or `--no-auto-rollback`). `rollback`: `0` done, `1` refused/failed.

Progress markers (`==> ` lines parsed by Agent Hub): `[BACK:<host>] Tagging current images as previous`, `[BACK:<host>] Backing up database`, `[BACK|FRONT:<host>] Rolling back to previous version` / `Rolled back to previous version` / `Rollback failed`, then `Deployment failed, previous version restored` (3), `Deployment failed, rollback failed` (4) or `Rollback completed`. The logic lives in `scripts/lib/deploy-versions.sh`; tests: `node --test scripts/deploy-versions.test.mjs` (stub executables, no host is contacted).

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
| **Database** | `DB_ENGINE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`, `DB_PASSWORD` | Postgres connection (`DB_ENGINE`: `postgres`, `cloud`, `supabase`, `neon`) |
| **DB options** | `DB_SSLMODE`, `DB_SSLROOTCERT`, `DB_POOLSIZE`, `DB_SCHEMA_MODE` | SSL, pool tuning, schema management (`sync` / `migrations` / `manual`) |
| **SQLite** | `DB_ENGINE=sqlite`, `DB_PATH` | Local file database instead of Postgres, single instance (see `modules_shared/database/README.md`). Written by the wizard (`DB_PATH=data/<project>.db`); `better-sqlite3` is added to `back/package.local.json` |
| **Database engine (scripts)** | `DB_ENGINE` | The only engine variable (the former `DATABASE_ENGINE` is refused by the back and by every script: rename it). `scripts/lib/db-engine.sh` is the single reader: `postgres`/`selfhosted` use `docker-compose.yml` (the `db` Postgres service), every other engine (`cloud`, `supabase`, `neon`, `sqlite`) uses `docker-compose-cloud.yml`, which has no database container; a compose file with a `db` service is refused for those engines. With `sqlite`, deploys keep the file on the `sqlite_data` volume (`DB_PATH=/data/<project>.db` set by the compose file, `/data` owned by the `node` user), require a single back host, `backup-db.sh` / `restore-db.sh` handle SQLite (online backup of the file, local or inside the remote back container; remote restore is manual), while `migrate-db.sh`, `migrate-server.sh` and `populate-db.sh` refuse to run (Postgres only) |
| **Security** | `ADMIN_TOKEN`, `CRYPT_DB_MASTER_KEY`, `CRYPT_DB_DERIVATION_SALT`, `CRYPT_SESSION_PRIVATE_KEY`, `CLIENT_ORIGINS` | Anonymous-mode admin key, encryption keys, CORS (`*` refused in production) |
| **HTTP server** | `HOST`, `TRUST_PROXY`, `RAW_BODY_PATHS`, `APP_VERSION`, `LOG_DIR`, `LOG_TO_FILE`, `APP_DATA_DIR` | Listen address, proxy trust, webhook raw-body paths, version in `/api/v1/health`, file logs (all optional, see `back/.env.example` and `nest/common/README.md`) |
| **Front served by the back** | `SERVE_FRONT_DIR` | Optional same-origin front (directory of the built front); see « Servir le front » in `nest/common/README.md` |
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
one consuming app needs. A dependency of a feature unique to an app goes in
the `package.fragment.json` of that feature (`<stack>/src/modules/<feature>/`,
merged after the shared modules' fragments; two fragments disagreeing on a
version print a warning). `package.local.json` (project-wide overlay) stays
minimal: `scripts`, `overrides`/pins and tooling used by project scripts. Before adding a new dependency to a project's `package.local.json`,
check whether another app on the template already carries the same package;
if so, it belongs in the base instead, so all apps track one version instead
of drifting apart silently.

Web3 / auth dependencies (`wagmi`, `viem`, `@reown/*`, `@openfort/openfort-js`, `@tanstack/react-query`,
`@base-org/account`, and on the back `bip322-js`, `jsonwebtoken`, `otplib`, `qrcode`, `tweetnacl`, `viem`) are NOT in this baseline anymore: they live in the `user` module's `package.fragment.json`
(react and nest) and are merged by `build-package.mjs` only when `user` is listed in `shared-modules.json`.
The version pins and the rationale for the `@wagmi/core` overrides are documented in `reactcommon/user/README.md`.

## User management (optional)

User management is enabled **only by listing `user` in `shared-modules.json`** (no environment variable).

- **Without `user`** (public default: `common`, `database`, optionally `voice`): anonymous mode. No login button, no web3 dependency
  in the bundle. The admin area (`/admin/*`) is protected by the `ADMIN_TOKEN` back env variable (>= 32 random chars,
  `openssl rand -hex 32`; empty = admin disabled). The front asks for the key once, keeps it in `sessionStorage` and sends it as
  `Authorization: Bearer`; a logout button appears in the header when it is set. `GET /api/v1/admin-session` returns 401 without a valid token.
  **Local trust mode** (single-user desktop/local app): `LOCAL_TRUST=true` + `HOST=127.0.0.1` makes requests from the loopback interface (socket address, local `Host` on `NODE_PORT`, `Origin` absent or local, no proxy header) administrators without a key; `admin-session` then answers `mode: 'local-trust'` and the front hides the key form and the logout button. The back refuses to start if `LOCAL_TRUST=true` and `HOST` is not a loopback address; the mode has no effect with the `user` module. Never enable it on a server. Details: `nest/common/README.md`.
- **With `user`**: full accounts, Reown login, wallet-based admin (`ADMIN_WALLET`), `/admin/user`. `user` needs only `common`
  (and `database`); `commerce` and `infra` are optional extras, see below. Nothing else to configure besides the usual `user` variables.

How it works: every shared module may expose a plugin (`plugin.ts` on the back, `plugin.tsx` on the front). `link-shared.mjs`
generates `back/src/modules_shared/plugins.generated.ts`; `front/src/plugins.ts` uses `import.meta.glob`. `AppModule.ts`, `App.tsx`,
`Router.tsx`, `Header.tsx` and `AppSidebar.tsx` read the plugins, so adding a module needs no edit there. The npm dependencies of a
module (e.g. wagmi/Reown for `user`) live in its `package.fragment.json`, merged by `build-package.mjs` when the module is linked.
On the back, `link-shared.mjs` warns about a listed module that has no plugin and that no file imports (candidates for removal from `shared-modules.json`).

Back plugin format (`NestModulePlugin`, details in `nest/common/README.md`, « Plugins »): `{ id, module?, modules?, order?, auth? }`.
`module` is a Nest module or a **factory** `(options) => DynamicModule`; `modules` adds further modules of the same folder; `order`
(default 100, lower first, ties in `shared-modules.json` order) sets the registration order. `AppModule.ts` imports
`sharedPluginModules` (generated). The options of factory plugins are given by the app in `back/src/config/pluginOptions.ts`
(created empty by the template, typed `PluginOptions`, keyed by plugin id); a missing option stops the app at startup with the plugin id
and the missing keys. Listed modules without a plugin are libraries imported by other modules: never write a plugin for them.

**Rate limiter**: `common` ships a global limiter (`@nestjs/throttler`, in `package.base.json`), OFF by default
(`common_throttleEnabled`, admin configuration). Turn it on for a new app together with `common_throttleDefaultLimit` (300) and
`common_throttleDefaultTtlMs` (60000); `REDIS_URL` shares the counters between replicas. An app that already registers its own
`ThrottlerModule` + `ThrottlerGuard` must keep `common_throttleEnabled` off (or drop its own and switch the key on), otherwise each
request is counted twice.

## Optional shared modules (`infra`, `commerce`, `oauth`)

`user` never imports `infra` or `commerce`, so a project can run with accounts only. They are plain shared modules: list them
in `shared-modules.json` with `node scripts/add-module.mjs <id>` (`--remove <id>` to drop them). **No edit of `AppModule.ts`**:
each ships a `plugin.ts` that `link-shared.mjs` collects into `plugins.generated.ts`.

| Module | Adds | Without it |
|---|---|---|
| `commerce` | products, orders, subscriptions; a tier is paid when an active recurring product grants it (`TIER_PRICING_PROVIDER`) | every tier is free |
| `infra` | health contributor (`HEALTH_CONTRIBUTORS`; `GET /api/v1/health` itself ships with `common`, so Docker healthchecks work without `infra`), Redis cache (`KEY_VALUE_CACHE`), Prometheus incl. `app_total_users` / `app_active_users_24h` (`USER_METRICS_SINK`) | tiers are read from the DB each time, no user gauges |
| `oauth` | OAuth2 token toolkit (parsing, refresh, PKCE) | n/a |

`helmet` is in the base `package.json` of every generated project (HTTP hardening in `common/bootstrap`); an existing project gets it the next time its `package.json` is regenerated (`build-package.mjs`).

The extension-point tokens are defined in `nest/common/types/ExtensionPoints.ts`; the optional module provides them globally and
`user` injects them with `@Optional() @Inject(TOKEN)`. The wizard adds `commerce` when you answer "selling", `infra` when you
answer "monitoring/health/Redis cache".

## Architecture

- **Monorepo**: `front/` (React + Vite + TypeScript) and `back/` (NestJS + TypeORM + Postgres)
- **Shared libraries**: modules from `.libs/vx-public` (MIT: common, database, voice) and `.libs/vx-private` (user, commerce, infra, ...),
  with `.libs/apptemplate` as alias of the template (legacy layout: `nestcommon`, `reactcommon`) — symlinked into `modules_shared/` by `link-shared.mjs`
- **Module-first**: business domains as dedicated modules, mirrored between front and back
- **Configuration**: seeded to DB via `defaultConfig.ts` (project-specific) + `configSchema.ts` (module-level)
- **Internationalization**: `back/src/locales/` — `common.*.json` + `custom.*.json`

## Create a project

```bash
./template/scripts/create-project.sh            # interactive wizard (Node >= 20, no dependency)
./template/scripts/create-project.sh my-app ~/projects --yes --entity "Acme" --email me@acme.io
./template/scripts/create-project.sh --answers project.config.json --yes     # replay / CI
./template/scripts/create-project.sh --dry-run ...                           # print the plan, write nothing
```

The wizard **never edits code**: it picks modules and produces configuration; the wiring goes through the modules'
plugins (`plugin.ts` / `plugin.tsx`). Questions (Enter = default; each has a CLI equivalent, see `--help`):

| # | Question | Effect |
|---|---|---|
| 1 | name, site name, publisher entity, contact email, ports | placeholders, `.env.dev` |
| 2 | access to the private modules? | mounts `vx-private` (`--private`) |
| 2b | **desktop application (Tauri)?** (`--desktop` / `--no-desktop`, default no; `--desktop-name` [site name], `--desktop-identifier` [`com.example.<name>`]; asked before the database) | writes the `desktop` section of `project.config.json` (`enabled`, `productName`, `identifier`, `sidecars: []`); enabled: SQLite becomes the proposed database, multi-user is not asked, local trust (3') is proposed (default yes); copies `desktop/` (the shell, `desktop.config.json` filled with the name and the reverse-domain identifier, `tauri.conf.json` synced) and `.github/workflows/build-desktop.yml`, and adds `desktop:dev` and `desktop:build` to `back/package.local.json` (see « Desktop application »). Refused with the `user` module, with a database other than SQLite or with an identifier that is not a reverse domain (letters, digits, hyphens, at least two dot-separated parts) |
| 3 | **multi-user application** (accounts, login)? | yes: the `user` module and what it `requires` (`common` only); no: anonymous mode, `ADMIN_TOKEN` generated in `back/.env.dev` |
| 3' | **single-user local application (local trust mode)?** (asked last, only without the user module; `--local-trust`) | writes `LOCAL_TRUST=true` and `HOST=127.0.0.1` in `back/.env.dev` (`ADMIN_TOKEN` is still generated) |
| 3a-c | login methods, sign-up (open / invitation / waiting list), several organizations | seeded values in `back/src/config/defaultConfig.ts` (+ `waitlist` / `tenant` modules); declared by the `user` manifest |
| 4 | **selling** (products, subscriptions)? | `features.commerce.enabled` seeded `true` / `false` and adds the `commerce` module (declining leaves it out); needs multi-user |
| 4b | **monitoring / health / Redis cache** (`infra`)? | adds the `infra` module (default yes when multi-user, else no) |
| 5 | functional modules (grouped by category, with description) | closure of `requires` shown before confirmation |
| 6 | database (selfhosted / cloud / supabase / neon / **sqlite**), Redis (default no) | `DB_ENGINE`, `.env` blocks; sqlite: `DB_PATH=data/<project>.db`, no `DB_*` Postgres variables, `better-sqlite3` in `back/package.local.json`. The question is asked **before** the modules: those that do not support the engine are not offered |
| 6b | **installable app (PWA)?** (`--pwa` / `--no-pwa`, default no; `--pwa-name`, `--pwa-short-name` (12 characters at most), `--pwa-theme-color`, `--pwa-background-color`) | writes the `pwa` section of `project.config.json` (`enabled`, `name`, `shortName`, `themeColor`, `backgroundColor`; name defaults to the site name, colors to a neutral pair); enabled: copies `front/pwa.plugin.ts`, `front/pwa-assets.config.ts`, `front/src/sw.ts`, `front/src/components/PwaInstallButton.tsx`, keeps the PWA tags of `front/index.html`, the `Header` button and the PWA lines of `front/public/_headers`, and adds `vite-plugin-pwa`, `@vite-pwa/assets-generator`, `workbox-*` and the `pwa:icons` script to `front/package.local.json` (see « Front public files and PWA ») |
| 7 | languages | `back/src/locales/custom.<lang>.json`, `localesLanguages`, `localeDefault` |
| 8 | recap | confirmation, then generation |

Files produced: `shared-modules.json`, `project.config.json` (the answers: replay or add a module later),
`back/.env.dev` + `back/.env.example` and `front/.env.dev` + `front/.env.example` (the `# @module <id>` ... `# @end`
blocks of the template examples are kept only for the linked modules; `# @module !user` = "when `user` is NOT linked"),
`back/src/config/defaultConfig.ts`. Inconsistent answers are refused with a message (private module without private access,
selling without accounts, a module that does not support the chosen database, unknown module...).

### Front build — public env guard (`viteConfig.ts`)

Every `VITE_*` value is inlined into the public bundle: never put a secret there (Prowl keys and `TECH_TOKEN` belong to
`back/.env`; the template no longer ships `VITE_PROWL_API_KEY` / `VITE_TECH_TOKEN` nor registers a tech token in
`front/src/config/configApis.ts`). `createViteConfig()` adds `envGuardPlugin()` (`vx-env-guard`, first plugin):
- it rewrites `import.meta.env ? import.meta.env.X : void 0|undefined` (and `import.meta.env && import.meta.env.X`) to
  `import.meta.env.X` — the guard of zustand's devtools middleware (pulled in by wagmi / Reown) made Vite inline the
  WHOLE env object, every `VITE_*` value included, into the `vanilla-*.js` chunk;
- at `generateBundle`, it **fails the build** (since 2026-10-18; it only warned before) when the value of a `VITE_*`
  variable whose name matches `/TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY/i` (8 characters or more) is found in an emitted
  file, without printing the value. A key that is public by design (e.g. a publishable key) is listed per app:
  `createViteConfig({ allowPublicEnv: ['VITE_OPENFORT_PUBLISHABLE_KEY'] })`. Only `vite build` runs this check (not the
  dev server); variables of the build machine's shell count too (`loadEnv` reads them).

### Front public files and PWA

Every project gets `front/public/` (copied once, then project-owned): `robots.txt` (allow all), `_redirects` (SPA fallback
`/*  /index.html  200` for Cloudflare Pages), `_headers` (`index.html` never cached, `/assets/*` immutable) and a neutral
`favicon.svg` (replace it with your logo: the header, the landing page and the route loader of the template use it, there is no `images/logo-main.*` file). `front/src/main.tsx` installs a **one-shot reload on `vite:preloadError`** (a tab
opened before a deploy asks for a chunk the new deploy removed): `installPreloadErrorReload` from
`common/utils/preloadReload.ts`, guarded against loops through `sessionStorage` (see `react/common/README.md`).

With the PWA enabled, the app is installable: `pwa.plugin.ts` (`vite-plugin-pwa`, `injectManifest`; manifest values come from
`project.config.json`), `src/sw.ts` (precache of the build assets + SPA navigation fallback; **`/api/` is never cached**,
data always comes from the network) and a header install button (`PwaInstallButton`, wired on `usePwaInstallPrompt`; shown
only when the browser offers the installation, with a Share-menu hint on iOS). After creation, put your logo in
`front/public/favicon.svg` and run `npm run pwa:icons` in `front/` to generate the icons (`public/pwa-*.png`,
`maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`, `favicon.ico`). `front/nginx.conf` serves `sw.js`,
`registerSW.js` and `manifest.webmanifest` with `Cache-Control: no-cache` (a cached service worker would block updates).
The wizard answers are in the `template/component-templates.json` « pwa » group; the `{{#PWA}}` ... `{{/PWA}}` blocks of
the copied files are kept or dropped according to `pwa.enabled`. Existing apps keep their own files.

Module manifest `<nest|react>/<module>/module.json`: `id`, `title`, `description`, `visibility`, `category`
(`core|users|business|ai|content|other`), `requires` (verified against the real imports by
`tools/check-boundaries.mjs --check-manifests`), `env` (variables added to `.env.example`), `questions` (module-specific
wizard questions with their effects: `config`, `configJson`, `env`, `modules`), and the optional `databases` (engine families the module
supports among `postgres` | `sqlite`; absent = all). A module that is not ported to SQLite (entities with Postgres-only
types or raw SQL) declares `"databases": ["postgres"]`; `create-project.mjs` and `add-module.mjs` then refuse it with a SQLite project
(`module "user" does not support the sqlite database (it supports: postgres)`), and so refuse the modules that `require` it.

Add or remove a module later (no code file is modified; `shared-modules.json`, `.env.example` blocks, `defaultConfig.ts`,
`package.json` and the module links are updated):

```bash
node scripts/add-module.mjs voice
node scripts/add-module.mjs --remove voice      # refused when another linked module requires it
```

### Desktop application

The desktop option turns the project into a Tauri 2 application (shell in `desktop/`, packaging scripts in `scripts/desktop/`,
details and `desktop.config.json` keys in `desktop/README.md`). Nothing is copied unless the option is chosen; the shell
runs the back with `DB_ENGINE=sqlite` and `LOCAL_TRUST=true`, hence the refusal with the `user` module or another
database. Declare extra processes (a Python engine...) in `desktop.sidecars` of `project.config.json` before creation, or in
`desktop/desktop.config.json` afterwards (`desktop.config.json` is the source of truth once the shell is installed).

```bash
node scripts/add-desktop.mjs --dry-run                 # existing project: print what would happen
node scripts/add-desktop.mjs --name "My App" --identifier org.acme.myapp
cd back && npm run desktop:dev                          # needs the Rust toolchain; builds nothing, uses back/dist and front/dist
./scripts/app.sh                                        # builds the app for this machine and launches it (--no-run, --no-build, --clean)
./scripts/bundle.sh                                     # packages in desktop/dist/: this machine's installer + win-x64 zip + linux-x64 tar.gz
./scripts/install.sh macos                              # builds for this machine and installs it (/Applications, /usr/local, %LOCALAPPDATA%\Programs)
```

`app.sh`, `bundle.sh` and `install.sh` (details in `desktop/README.md`, « Build and package scripts ») build back + front, call the project's
optional `scripts-local/desktop-prepare.sh <target>` (what `packaging.extraResources` copies, e.g. an embedded engine), then
`scripts/desktop/build-desktop.mjs`. `npm run desktop:build` (from `back/`) is `app.sh --no-run`.

`add-desktop.mjs` has the same effects as answering yes to the question: it copies `desktop/` and the workflow, writes the
`desktop` section of `project.config.json`, fills `desktop/desktop.config.json`, adds the two scripts to
`back/package.local.json` and regenerates `back/package.json`. It overwrites nothing: it is refused when the option is already
enabled, when `desktop/` or the workflow already exists, with the `user` module, with a database other than SQLite and with an
invalid identifier. The identifier names the OS data folder of the app: change the `com.example.*` placeholder before shipping.

## Library scripts (vx-public / vx-private)

| Script | Purpose |
|---|---|
| `scripts/create-project.sh [options] [<name> [dir]]` | New project (wizard above): mounts `vx-public` (+ `vx-private`) in `back/.libs` and `front/.libs`, `.libs/apptemplate` symlinks, `shared-modules.json`, env files. URLs: `VX_PUBLIC_URL` / `VX_PRIVATE_URL` (defaults: `https://github.com/bccapps/WebAppTemplate-{public,private}.git`) |
| `scripts/add-module.mjs <id>... [--remove]` | Add / remove shared modules in an existing project |
| `scripts/add-desktop.mjs [--name <text>] [--identifier <id>] [--dry-run]` | Add the desktop shell (Tauri) to an existing project (see « Desktop application ») |
| `scripts/update_common.sh [--push-only\|--pull-only]` | For each mounted library: commit local changes of the back mount, fetch, rebase on `origin/main`, push; then the same on the front mount; both end on the same SHA; the parent repo gets a `chore: bump <lib>` commit. Then symlinks, `package.json` regeneration. Refuses a legacy app (run the migration first) |
| `scripts/migrate-to-webapptemplate.sh` | One-shot, idempotent migration of a legacy app (`nestcommon`/`reactcommon`/`apptemplate` submodules). Does not commit |
| `scripts/deploy-full.sh` | Deploys with the **latest `main`** of the libraries (`git submodule update --init --remote`), not the refs pinned by the app commit |

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