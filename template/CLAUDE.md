# Project Context

Rules only; the how-to lives in the READMEs linked from each rule (template `README.md`, `nest/common/README.md`, `react/common/README.md`, `nest/database/README.md`, `desktop/README.md`).

## 1. Architecture Overview

- **Monorepo**: `front/` (React + Vite) and `back/` (NestJS + TypeORM + Postgres or SQLite).
- **Module-first**: a business capability = one module on both front & back, same names on both layers; new domains in `src/modules/<feature>`, same-module imports by relative path only.
- **Shared modules**: `{back,front}/src/modules_shared` (symlinks into `.libs/`). **README-first (MANDATORY)**: read a module's README before touching it or reimplementing anything; a capability that belongs to a shared module goes there, README updated in the same change. Do not modify a shared module without asking.
- **Remote API modules (MANDATORY)**: if `front/src/config/configApis.ts` → `apiUrlMap` maps a module to a remote URL, its data lives on that API: the back never uses its local entities/repos/services, it uses (or creates) the `<module>-remote` variant — transitively, for every service of any module needing that data (local tables are empty). The original symlink may still be needed by other modules.
- **API base URLs (MANDATORY)**: every HTTP call of `front/src/modules_shared` uses `configurationService.getApiUrl('moduleId')` (already includes `/api/v1`) + the resource path. Never hardcode `/api/...` nor import `getApiBaseUrl`.
- **Internationalization**: user-facing strings in `back/src/locales`: `common.*.json` = reusable common-language keys only (unrelated to the `common` module), `custom.*.json` = app-specific; `back/src/locales/common.*.json` is a **real file** in every app, never a symlink (`npm run locales:sync` only adds missing keys from the template). A shared module's keys ship in `<module>/locales/` (front ones are bundled into every app); never copy them into `common.*.json`. `npm run i18n:check` is the CI gate.

### 1b. Shared libraries (submodules)

`vx-public` (this template + public modules `common`, `database`, `voice`) and, when the project has access, `vx-private` (its rules: `CLAUDE.private.md`), each mounted twice (`back/.libs/` and `front/.libs/`: Node resolves from a file's real path). `<stack>/.libs/apptemplate` → `vx-public/template`; root `scripts` → `front/.libs/apptemplate/scripts`. Resolution order, generated docs, config links: template `README.md`, « Project layout and agent docs ».

- **Project docs**: the root `CLAUDE.md` is generated (`@imports` + `<!-- project-specific notes below -->`): write project notes below the marker only. `AGENTS.md` is generated and git-ignored: never edit it.
- **Editing libraries (MANDATORY)**: edit them in their `.libs/` working tree only (never another clone), publish with `./scripts/update_common.sh` from the project root (`--push-only`, `--pull-only`), then `git push` the parent. `vx-public` canonical mount = `front/.libs/vx-public/` (= `front/.libs/apptemplate/`); the back mount is synchronized by the script. Deploys take the latest `main` of each library (with `DEPLOY_FROM_MAIN=true`: the commits the project's `main` records).
- **Shared modules in a project**: `node scripts/add-module.mjs <id>` / `--remove <id>`; never import a shared module by hand in `AppModule` — wiring goes through its plugin.
- **Back plugins**: `export const plugin: NestModulePlugin = { id, module?, modules?, order?, auth? }`; factory form `(options) => DynamicModule` validated with `requirePluginOptions`, options in `back/src/config/pluginOptions.ts` (`false` disables a plugin, `excludeModules` drops some of its modules). Contract: `nest/common/README.md`, « Plugins ».
  - **Libraries rule**: a module that other modules import (e.g. `tokens-api`, `api-access`) has NO plugin and stays listed in `shared-modules.json` (for the symlink). Never write a plugin calling a `forRoot` another module also calls (second instance: duplicate services and crons); a plugin registers at the app ROOT only.
  - `common` ships a global rate limiter (`common_throttleEnabled`: off in the library, seeded on by `create-project` for a new app): no second `ThrottlerGuard` while it is on, per-route budgets through `@Throttle` / `ThrottleRegistry`, never a hand-made `ThrottlerModule` (`nest/common/README.md`, « Limiteur de débit »).
- **Optional modules (MANDATORY)**: `user` and `common` never statically import `commerce` or `infra` (pruned when unlisted): cross through the `@Optional() @Inject(TOKEN)` extension points of `common/types/ExtensionPoints.ts`; the consumer degrades gracefully without them.
- **Desktop shell (optional)**: `desktop/` (Tauri 2), added by `create-project.mjs --desktop` or `scripts/add-desktop.mjs`; project specifics in `desktop/desktop.config.json` only, never project logic in `desktop/src-tauri`. Everything else: `desktop/README.md`.
- **`package.json` is GENERATED — never edit it (MANDATORY)**: `build-package.mjs` merges `package.base.json` (shared) → `package.fragment.json` of each listed shared module → `src/modules/<feature>/package.fragment.json` (app features) → `package.local.json`, and overwrites `<stack>/package.json` on every install/build (direct edits are wiped; a fresh clone installs what is committed).
  - Dependency every/several apps need → `package.base.json` in the front `vx-public` mount. Dependency of one feature → that feature's `package.fragment.json`. `package.local.json` stays minimal: project-specific `scripts`, `overrides`/pins, tooling of project scripts (common scripts come from the base).
  - Then `node .libs/apptemplate/scripts/build-package.mjs <stack> && npm install`, commit `package.json` + `package-lock.json` + the edited source file.
- **`.env.example` is GENERATED too (MANDATORY)**: `build-package.mjs` writes `<stack>/.env.example` from the template example (blocks of the linked modules) + the `env` of their `module.json` + `<stack>/.env.example.local`; a project-specific variable goes in `.env.example.local`, a module's in its `module.json`.
- **Template files (MANDATORY)**: every `config-links.json` target stays a symlink (no project copy); a project need goes into the template, generically.

## 2. Frontend Stack

- **Tech**: React + Vite + TypeScript, React Router, MUI, HttpService, Toast/Loader. Wagmi/Reown and TanStack Query come ONLY with the `user` plugin. Optional landing page via the `useLandingPage` config. Shell, layouts (`page` | `admin` | `fullscreen`), routing, guards, navigation and the `AppPlugin` contract: `react/common/README.md`.
- **Module plugins (MANDATORY)**: shared modules plug in through `plugin.tsx` (front, collected by `src/plugins.ts`) / `plugin.ts` (back, `plugins.generated.ts`): adding or removing one requires NO edit of `App.tsx`, `Router.tsx`, `Header.tsx`, `AppSidebar.tsx`, `AppModule.ts`. App-owned overrides: `config/pluginOptions.ts`, `config/pluginRoutes.ts` (disable/replace a plugin route), `config/navigation.ts`. Shared code uses `sessionAuth` (`common/auth/sessionAuth`), not `userService`; `userManagementEnabled` tells whether `user` is linked (otherwise the admin is protected by `ADMIN_TOKEN` + `AdminTokenGate`). `Admin*`/`Dashboard*` panels are auto-discovered.
- **Routes**: declared in `Router.tsx` (`{ path, element | lazy, guard?, layout? }`); a custom header renders `<PluginHeaderActions />`.
- **Public files**: `front/public/` is project-owned. `main.tsx` keeps `installPreloadErrorReload` (no unguarded `location.reload()`). PWA: the service worker never caches `/api/` (template `README.md`, « Front public files and PWA »).
- **Code**: small reusable components, logic in hooks/services; use `configurationService`, Toast, Loader, HttpService and `modules_shared` instead of reimplementing.
- **Page = thin wrapper (MANDATORY)**: `components/pages/` only compose module components, handle route params, feature gating and layout; logic, forms, lists, state and fetching live in the module.
- **Themes & styles (MANDATORY)**: an app's look lives in a **theme** (`common/themes/<id>/` shared, `front/src/themes/<id>/` private = the app's identity, `appDefault: true`), never in a component. Details: `react/common/README.md`, « Système de thèmes visuels », « Jetons des modules » and « Feuilles partagées et feuilles d'app ». Chain: component → token (`var(--…)`) → theme override.
  - **Colors**: no hex/rgb/hsl literal in a component or its CSS (`.ts`, `.tsx`, `.css` of the app and of a module). Components read the token contract `common/theme/tokens.css` or their module's `<module>/styles/tokens.css` (`--<module>-<component>-<role>`, defaults in `:where(:root)`, the only place for literals). A theme overrides tokens, never a component. In `sx`/`style` use `'var(--token)'`; a color a JS API needs resolved (canvas, charts, MUI `alpha()`, SVG attributes, xterm) is read from the theme at runtime (`getComputedStyle(document.documentElement).getPropertyValue('--token')`, re-read on theme/mode change), never `var()` in a canvas option; data colors (series, avatars, user-picked, brand colors of a third party) stay data.
  - **Gate**: `npm run theme:check` (front, `scripts/check-theme-colors.mjs`; `theme:audit` lists) fails on any literal outside token files, theme folders and specs: including the fallback of a `var(--token, #fff)` (drop it when the token is always defined, else make the fallback a token). Never counted: a line marked `theme-colors-ignore: <reason>` (or the line after it), a file marked `theme-colors-ignore-file: <reason>` in its first 40 lines (data: brand colors, palettes, QR codes), engines/canvas by path in `.themecolorsrc.json` (`"ignore": [regex…]`, reason in the project docs). `--libs` (or `"scanLibs": true`) also checks the linked shared modules: set it in a project that edits the libraries. A legacy app records today's counts with `--update-baseline` (`.themecolors-baseline.json`): no new literal, the old ones paid down file by file; `--allow-fallbacks` relaxes the fallback rule while migrating. Run it before each front commit that touches a component or a sheet, with `lint`.
  - **How to add a color**: look for an existing token first (`tokens.css` of the module, then `common/theme/tokens.css`, then the app's `themes/<id>/colors.css`); else add `--<module>-<component>-<role>: <value>` to the module's `styles/tokens.css` (list it in the module README) and read it with `var()`. To restyle an app, edit `themes/<id>/colors.css` (and `app.css` for rules), never the component.
  - **New theme**: `front/src/themes/<id>/index.ts` (`ThemeDefinition`, `export default`, discovered automatically) + `colors.css` overriding `:root[data-theme='<id>']` tokens only (steps and template: `react/common/README.md`, « Créer un thème »). Dark mode is `data-color-scheme`, distinct from `data-theme`.
  - **Images & fonts**: declared by the theme (`images`, `fonts`), read with `useThemeImage(key)`; never hardcode `/images/logo-*.svg`, no font `@import` in shared CSS.
  - **No per-app copy of shared styles**: shared sheets in `common/styles/` (`shared_ui.css`, `theme_default.css`), a module's own CSS in `<module>/styles/<module>.css`, imported by relative path (never `@/styles/...`, no CSS `@import` between them); app differences in `themes/<id>/colors.css` + `app.css`. An app-wide sheet shared by several modules lives in `themes/<id>/` (loaded by its `styles.ts`), not in `src/styles/`.
- **Tables (MANDATORY)**: sortable clickable headers (`TableSortLabel`) via `common/hooks/useSortableTable`; Actions/Color columns stay plain.
- **Session reactivity (MANDATORY)**: a component depending on session state calls `useSessionKeys([...keys])` (`common/hooks/useSessionKeys`) at the top, or `appSession.get(key)` goes stale.
- **Forms**: required fields marked, error on submit when missing; while submitting: loading state, fields and modal close blocked; modal background blurred.

## 3. Backend Stack

- **Tech**: NestJS, TypeORM, Postgres or SQLite, ScheduleModule for crons.
- **Entry**: `main.ts` → `startApp({ appModule, ... })` (`common/bootstrap/startApp.ts`); `main.ts` holds only project specifics, never copies the common steps back. HTTP hardening (helmet, CORS, rawBody, `ValidationPipe`) = `configureHttpApp(app)` (options `extraCorsHeaders`, `validation`, `publicCorsPaths`, `corsOriginPolicy`); never `enableCors`/`useGlobalPipes` by hand. **Every middleware, `SwaggerModule.setup` and `serveFrontend` is registered BEFORE `app.init()`** (afterwards they are silently unreachable). Env and options: `nest/common/README.md`, `back/.env.example`.
- **Health**: `GET /api/v1/health` belongs to `common`; add a `HEALTH_CONTRIBUTORS` contributor, never another controller on that path.
- **Database engine**: Postgres default, SQLite with `DB_ENGINE=sqlite`. A module not ported to SQLite declares `"databases": ["postgres"]` in its `module.json` (all vx-private modules with entities today); `common` and `voice` never import `database`. Portable types, `DB_SCHEMA_MODE`, `npm run db:check` (the gate): `nest/database/README.md`. Portability rule: §5.
- **TypeORM sync safety (MANDATORY)**: before renaming/removing a column, changing a type or removing an entity, **STOP and warn the user** (`synchronize: true` silently drops data): list each destructive change and its impact, wait for explicit confirmation. Nullable columns and new entities may proceed.
- **Global config**: `defaultConfig.ts` → `ConfigSeederService` → DB → `ConfigurationService`.
- **Email (MANDATORY)**: always `EmailService.sendEmail(to, subject, html, options?)` (`common/services/EmailService.ts`), never a custom nodemailer transporter.
- **Outbound HTTP to third-party APIs (MANDATORY)**: never raw `fetch`/`axios`; use `throttledFetch` (`common/utils/throttledFetch.ts`: spacing, retry with backoff, never throws → `{ data: null, stale: true }`), with a thin per-source wrapper for a new source.

## 4. Module Configuration Schema and Admin Components

- **Back**: `configSchema.ts` (`ModuleConfigSchema`: moduleId, fields `{ key, type, defaultValue, group }`) registered by an `OnApplicationBootstrap` service (`moduleConfigService.register(schema)`) in the module providers; `ModuleConfigSeederService` seeds the defaults. A key also in `defaultConfig.ts` takes the `defaultConfig.ts` value; a value already in DB is never overwritten. Seed `config` only through `insertConfigIfAbsent` (seeders run concurrently), never find-then-save.
- **Types**: `string | number | boolean | select | multiselect | json | secret`. **Groups**: `general | polling | streaming | reliability | sources | filtering | performance`. **Locales**: `<module>/locales`, key `{moduleId}_{configKey}`.
- **Front**: `<AdminPage />` shows global + module configs; a module may add `Admin*.tsx` (its config) and `Dashboard*.tsx` (admin stats).
- DTOs: 1 DTO per entity, 1 file per DTO, 1 file per entity.
- **Module README (MANDATORY)**, created with the module and updated in the same change as any endpoint/service/component/entity change, precise enough to integrate the module without reading its source:
  - back: Rôle, Architecture (entities/controllers/services/mappers), Dépendances, **Endpoints exposés (exhaustif)** (Méthode/Endpoint/Auth/Description for EVERY route), Entités, Points d'extension;
  - front: Rôle, Structure, **Services** (Méthode/Endpoint/Description for every HTTP call), Composants, Types principaux, Dépendances.

Feature access control (`hasFeature`, `@RequireFeature`, tiers) only exists with the `user` module: `CLAUDE.private.md` §4b.

## 5. Development Workflow & Conventions

**Principles:** DRY, destructuring, early returns, simplicity > cleverness, separation of concerns.

- **Before coding**: clarify requirements; non-trivial feature → short plan validated first; read the READMEs of the shared modules involved and `ARCHITECTURE.md` (and `FEATURES.md` at the start of a non-trivial session).
- **While coding**: small increments; tests alongside (every public function has a unit test); don't refactor what you just wrote without reason; verify assumptions on official sources (current development tree, not only the last release); keep platforms (web, mobile, desktop…) aligned and flag blockers.
- **Do the checks yourself** (§8) and the debugging too (commands, throwaway programs, servers, DB reads, logs); ask the user only for what cannot be automated.
- **Keep context small**: relevant files only, one task per session; `.claudeignore` excludes `node_modules/`, `dist/`, `build/`, `coverage/`, `*.lock`, `*.log`, `logs/`, `.db/`, `.env*`.

**Git branches (MANDATORY)** — the project repo only (the one holding this file)
- Work only from branch `dev`: create it from `main` if missing, then switch to it before any change.
- Extra work branches are allowed; every merge (manual or automatic) targets `dev` only.
- Never merge into or push `main` on your own: the user does it to publish a roughly stable `dev`.
- Every other repo stays on its default branch (`main`), commits go there directly: the libraries (`.libs/*`, published by `update_common.sh`) and any data/asset repo the project uses, nested or sibling (theme packs, datasets…), even when edited in the same session. « Passe sur dev » / « switch to dev » means the project repo alone; never create `dev` elsewhere.

**Conventions**
- Code and comments in English; `camelCase` functions, `PascalCase` classes, `SCREAMING_SNAKE_CASE` constants; Conventional Commits; functions < 40 lines, moderate files.
- **Strong typing**: interfaces for all props, no `any`, explicit types where inference fails (strict mode).
- **PostgreSQL AND SQLite (MANDATORY)**: every entity, query and raw SQL works on both engines. TypeORM operators/`QueryBuilder` first, then `common/utils/dbDialect.ts` or `portableQuery`; no Postgres-only SQL (`ILIKE`, `::`, `@>`, `->>`, `to_char`, `NOW()`, `ANY()`, `SKIP LOCKED`, advisory locks, `percentile_cont`, `date_trunc`). When something cannot be portable, say so BEFORE coding (what, why, cost of the portable alternative) and let the user decide; a restriction goes in `module.json` (`"databases": ["postgres"]`) and each such query is marked `// pg-only: <reason>`.
- **Performance**: `useMemo` for expensive computations, `useCallback` for handlers, `React.memo` for pure components.
- **i18n**: key in every locale file; NEVER `defaultLabel` on `<I18nLabel>` nor a default in `i18n.get()` (missing translations must show).
- **Live updates**: push through `EventStreamService` (`common/event-stream`), `useLiveResource` / `useServerEvents` on the front; no new polling for server-pushable data.
- **Configuration discipline**: global settings → `defaultConfig.ts` + translations (never `config.ts`); user settings → `UserSetting` (`user` module); module settings → §4.

## 6. Code Quality

- JSX: simple logic inline, complex → `useMemo` or functions above the return.
- ALWAYS read before editing; targeted edits; preserve user changes.
- Before finalizing: no `console.log`, temp variables or unused imports; only code that solves the issue.
- Validate at boundaries only; user-friendly errors via i18n.
- No over-engineering: no extra features, impossible cases, premature abstractions or compat hacks.
- **File header (MANDATORY)**: every new file of the template and public modules starts with the MIT header below (vx-private: `CLAUDE.private.md` §6; projects may define their own).
```
/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
```

## 7. Documentation

- **`FEATURES.md` (MANDATORY)**: canonical inventory of what is built (not a changelog), updated in the same change as a significant feature.
- **`ARCHITECTURE.md` (MANDATORY)**: the entry point; owns the *shape* (data flow, ownership, state machines, per-platform reality, safety nets) and, at its top, the **Documentation map** — the single list of annexes and what each owns.
- JSDoc on public functions; inline comments for non-obvious logic only; READMEs updated when exposed behavior changes (§4).
- **One fact, one place**: a device is described in ONE file, everywhere else links to it. Ask which file owns the question; never restate a constant, cite its owner; verify values against the source, not another doc; fix a stale sentence where it stands instead of adding a newer truth beside it; a new doc goes under `docs/<theme>/` and into the Documentation map; reference annexes by path; annexes carry `Last verified against source: <date>`.
- Manual test procedures and TODO lists only on request.

## 8. Run Script & Verification Loop

- **Launch script (MANDATORY)**: `./run.sh` or `./scripts/run.sh` (no parallel `start.sh`) really starts the app, with OS autodetection (macOS, Linux, Windows; Android emulator for an Android app), updated with any change to how the app starts. Extra dev processes go in `scripts-local/dev-services.sh` (`DEV_SERVICES_HOOK`), never in a fork of `run.sh`. Dev-only values in `back/.env.dev`, never `back/.env` (shipped to production).
- **Verification loop, measured**: while iterating, the cheap type-check/lint + the specs you touched; before committing, the full suite, `npm run typecheck:specs` (ts-jest and Vitest never type-check the specs), `npm run i18n:check` and, for the front, `npm run theme:check` once. Record the measured durations (command, date) in the project notes of the root `CLAUDE.md` (table skeleton: template `README.md`, « Verification loop »); re-measure when off by ~2×; a slow suite is a signal to investigate.
- **Front Vitest**: `front/vitest.config.ts` = `createVitestConfig()` (template, `preserveSymlinks: true`); never a Vitest config of your own without it.
- **Machine resources (MANDATORY)**: the machine is shared (other agent sessions, apps, browsers). Before a heavy command (full test suite, build, big type-check, Docker build, local model load) check memory and load (`memory_pressure -Q`, `sysctl vm.swapusage`, `uptime` on macOS; `free -g`, `uptime` on Linux) and the heavy processes already running (`ps -axo pid,rss,etime,command -m | head`); memory short, swap growing or another heavy job running ⇒ wait for it or ask, never pile on. One heavy job at a time on the machine: never two full suites, builds or model loads in parallel, never one per sub-agent (sub-agents: the specs they touch with `--maxWorkers=2`, one e2e file `--runInBand`; the full suites run once, by the orchestrator, one after the other). Test runners stay capped (template Jest/Vitest configs: half the cores, a Jest worker restarted past 1 GB; never raise it). A run that swaps or stalls is stopped (`pkill -P <pid>`), not waited out; leftover test or dev-server trees are killed before the next wave. Detail: template `README.md`, « Verification loop ».

## 9. Repo Map

`python3 scripts/repo_map.py . --check` (stale ⇒ exit 1) / `--save --stats` (regenerate): `.repo-map.md`, regenerated after source changes before closing a task (never committed by hand). Navigation aid only: grep it or read one section; **never** conclude that something does not exist from it — grep the source. Coverage and levels: template `README.md`, « Repo map ».

## 10. Security

- No secrets, keys or passwords in prompts or code. All user input validated **server-side**. Every dependency justified, established and maintained (where to declare it: §1b).
- Authentication, payments, personal data: mandatory human review.
- HTTP hardening only through `configureHttpApp`: never disable `helmet`, widen CORS to `*` in production, wrap `enableCors` or parse webhook bodies by hand (webhooks read `req.rawBody`, `RAW_BODY_PATHS`); per-route CORS openings via `publicCorsPaths` / `corsOriginPolicy` (`nest/common/README.md`). Client IP = `req.ip` (`extractClientIp`), never `X-Forwarded-For` read by hand; behind proxies `TRUST_PROXY` is a list of trusted addresses, not a hop count.
- `LOCAL_TRUST=true` (single-user local apps only): never on a server, never weaken its checks (loopback **socket** address, never `req.ip`/`X-Forwarded-For`); per-user app routes still use `RequireUserInterceptor`.
- Remote command execution / terminal sessions are security-critical: least privilege, no unvalidated input in a command line, no credentials in logs.

## 11. Communication & Expected Behavior

- **Be critical, not apologetic**: if a request contradicts these rules, the architecture or a simpler path, say so *before* acting, with reasons; agreement must be earned.
- Focus on solutions; **flag uncertainties** instead of inventing; **propose alternatives** with trade-offs and a recommendation.
- **Announce the plan before acting** on a task spanning more than 3 files; **flag any change outside the requested scope**; ask a short question when intent is unclear.
- Plans extremely concise; once validated, don't interrupt yourself until everything is done; finish with a synthesis, then open questions or suggestions.

---
**Updated:** 2026-10-27 — keep under ~6,000 tokens: rules here, detail in the READMEs/annexes (§7). Getting started: template `README.md`, « Needed Customizations ».
