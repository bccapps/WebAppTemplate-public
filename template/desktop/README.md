<!--
  VXFramework

  Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
  SPDX-License-Identifier: MIT

  Licensed under the MIT License. See LICENSE in the project root.
-->

# Desktop shell (Tauri 2)

Optional, generic desktop shell for a project made from this template. It opens a waiting page, starts the back
(Node) on a free `127.0.0.1` port, waits for its health endpoint, then navigates the window to
`http://127.0.0.1:<port>/`: the back serves the built front (`SERVE_FRONT_DIR`), so the front keeps its relative API
URLs and nothing changes in it. Why not `tauri://`: `LOCAL_TRUST` refuses that origin by design
(`nest/common/README.md`, « Mode local de confiance »).

Optional **sidecars** (extra processes such as a Python engine) are declared in the config and supervised the same way.
The shell contains no project logic: everything specific is in `desktop.config.json`.

## Layout

```
desktop/
  desktop.config.json      # the only file a project edits (embedded in the binary at build time)
  package.json             # scripts: sync, test, dev, build
  splash/                  # waiting page (index.html) + default fr/en messages (messages.json)
  launchers/                # generic sidecar launchers: run-unix-sidecar.sh (macOS/Linux), run-in-wsl.ps1 (Windows, WSL2)
  scripts/sync-tauri-config.mjs   # desktop.config.json -> src-tauri/tauri.conf.json (+ project version)
  src-tauri/               # Rust shell (config, environment, resources, logs, health, process, splash, downloads, boot)
```

## `desktop.config.json`

| Key | Meaning |
|---|---|
| `productName`, `identifier` | App name and reverse-DNS id. Also written into `tauri.conf.json` by `npm run sync` (run by `dev`/`build`). The id decides the OS data folder. |
| `window` | `title` (default: `productName`), `width`, `height`, `minWidth`, `minHeight`, `theme` (`dark`, `light`, `system`). |
| `resources.marker` | File, relative to the resources folder, that identifies it (default `back/dist/main.js`). |
| `resources.frontDir` | Built front relative to the resources folder, exported as `SERVE_FRONT_DIR` (default `front/dist`). |
| `dbFile` | SQLite file name inside the data folder (default `app.db`), exported as `DB_PATH`. |
| `schema` | How the database schema is managed at boot: `sync` (synchronize, no migrations), `migrations` (the app's own SQLite migrations run at start) or `manual`. The shell forces it as `DB_SCHEMA_MODE`. Absent = legacy: the shell forces `DB_MIGRATIONS_RUN=true` (apps with hand-written SQLite migrations keep working unchanged). An app whose migrations are PostgreSQL SQL (a desktop *variant* of a web app) declares `"schema": "sync"`. Details: `nest/database/README.md`, "Schema management". |
| `server` | The back. `command` (string or candidate list), `args`, `cwd`, `env`, `healthPath` (default `/api/v1/health`), `readyTimeoutSec` (default 120), `sharedToken`. |
| `sidecars[]` | Same shape as `server`, plus `name` (required, unique, not `server`), `label`, `port`, `optional` and `os`. Started in order **before** the server (those whose `os` list does not contain this OS are skipped). |
| `packaging` | `nodeVersion` (default: pinned) and `extraResources`, read by the packaging scripts only (see Packaging). |
| `splash.brand` | `background`, `foreground`, `accent` colors of the waiting page (and of the window background). |
| `splash.texts` | `{ "fr": { id: text }, "en": { ... } }` overrides of the default messages (`splash/messages.json`). |

Process fields:

- `command`: a string, or a list of candidates. The first usable one wins: a path must exist (on Windows `.exe` is tried
  too), a bare name is looked up in `PATH`. Example: `["{resources}/runtime/node/node", "node"]` runs the embedded Node
  when packaged and the system Node in development.
- `args`, `cwd`, `env` values accept placeholders: `{resources}`, `{dataDir}`, `{logsDir}`, `{port}` (the process's own
  port) and `{port:<name>}` (another process's port, e.g. `{port:engine}`). Other brace text is left untouched.
- `port` (sidecars; always on for the server): allocate a free loopback port. `healthPath` needs it; a sidecar with a
  `healthPath` is waited for (up to `readyTimeoutSec`) before the next process starts, one without is not waited for.
- `sharedToken`: name of an env var (or a list of names, all receiving the same value) that receives a token generated at
  **each launch** (32 random bytes in hex), the same value for every process that asks. The name may differ per process:
  `"sharedToken": "LOCAL_RUNNER_TOKEN"` on the server and `"sharedToken": "RUNNER_TOKEN"` on a runner sidecar let the back
  authenticate the runner that connects to it, with no token written anywhere.
- `optional` (sidecars only, default `false`): the process is auxiliary. If it cannot start, exits at start-up, never becomes
  ready or dies later, the failure is written to `shell.log` (and its own `<name>.log`) and **the app goes on without it**; the
  waiting page does not show it. Use it for a process whose prerequisites may be missing on a machine (a runner needing `tmux`).
- `os` (sidecars only, default: every OS): the operating systems the process runs on, among `macos`, `linux`, `windows`.
  Declare one sidecar per OS family when the launch differs (see "Launchers").

Example with a sidecar:

```json
{
  "productName": "Studio", "identifier": "app.example.studio",
  "server": { "command": ["{resources}/runtime/node/node", "node"], "args": ["dist/main.js"], "cwd": "{resources}/back",
              "env": { "ENGINE_URL": "http://127.0.0.1:{port:engine}" }, "sharedToken": "ENGINE_TOKEN" },
  "sidecars": [
    { "name": "engine", "label": "engine", "command": "{resources}/engine/run", "args": ["--port", "{port}"],
      "port": true, "healthPath": "/health", "readyTimeoutSec": 240, "sharedToken": "ENGINE_TOKEN" }
  ]
}
```

## What the shell does at each launch

1. **Resources folder**, first match: `DESKTOP_RESOURCES` (development, trusted as is), the folder of the executable
   (portable layout), Tauri's resource folder (installed app). The last two must contain `resources.marker`.
   The layout mirrors the repository: `back/dist/main.js`, `back/node_modules`, `front/dist`, plus whatever the config
   references (`runtime/node/node`, sidecar files).
2. **Data folder** = the OS per-user local data folder of the `identifier` (e.g. `~/Library/Application Support/<id>`).
   Logs go to `<data>/logs`: `shell.log`, `<name>.log` per process (the previous run is kept as `<name>.previous.log`).
3. **Secrets**: `<data>/secrets.json` (mode 0600 on Unix) holds `CRYPT_DB_MASTER_KEY` and `CRYPT_SESSION_PRIVATE_KEY`
   (32 random bytes, base64, same rule as `backEnvValues` in `scripts/create-project.mjs`), generated on first launch only.
4. **Environment of the back**: the config `env`, then the secrets, then these variables, which always win:
   `HOST=127.0.0.1`, `NODE_PORT`, `CLIENT_ORIGINS` (`http://127.0.0.1:<port>`, `http://localhost:<port>`),
   `LOCAL_TRUST=true`, `DB_ENGINE=sqlite` (forced, so an inherited `DB_ENGINE=postgres` of a developer's shell cannot win), `DB_PATH=<data>/<dbFile>`, `DB_SCHEMA_MODE=<schema>` when the config declares `schema` (otherwise the legacy `DB_MIGRATIONS_RUN=true`, never both),
   `APP_DATA_DIR=<data>`, `LOG_DIR=<data>/logs`, `SHARED_DIRECTORY=<data>/shared`, `DISABLE_TRANSPORT_CRYPTO=true`,
   `APP_ENV=desktop`, `SERVE_FRONT_DIR`, `DESKTOP_PARENT_PID` (the shell pid; the back exits when it disappears, see
   `nest/common/README.md`). Sidecars receive only their config `env` plus the shared token.
   **Precedence.** Forced by the shell > secrets file > config `env` > the environment the shell was started with (inherited).
   The packaged back does not read any `.env*` file: the resources never contain one (`build-desktop.mjs` copies `back/dist`,
   `package.json`, the locales and the production `node_modules` only; a desktop variant build excludes every `.env*` of the
   developer's tree), and `node dist/main.js` loads none by itself (`env-cmd` is only used by the project's npm scripts). So the
   engine, the trust mode and the paths are the shell's whatever `back/.env*` says. Variables the shell does not force
   (an app's own directories…) go in the server's `env` of `desktop.config.json`.
5. Sidecars, then the server, are started in their own process group; the shell waits for each health path; the window
   then goes to the front. If a process exits during start-up, or the health wait times out, the waiting page shows the
   error and the last 40 log lines. If one dies later, the window returns to the waiting page with the same details.
6. **Shutdown** (window closed, SIGTERM/SIGINT/SIGHUP): the groups get `SIGTERM`, then `SIGKILL` after 6 s (Windows:
   `taskkill /T /F`). Safety nets if the shell itself is killed: a detached sentinel process on Unix, a Job Object with
   kill-on-close on Windows.
7. Also: single instance (a second launch focuses the window), window built in code (downloads, no drag-and-drop
   interception), Linux DMA-BUF workaround.

## Launchers and sidecars on each OS

`launchers/` (copied into the project, shipped as `packaging.extraResources: [{ "from": "desktop/launchers", "to": "launchers" }]`)
holds two generic scripts for a sidecar that needs tools of the user's machine:

- **macOS / Linux, `run-unix-sidecar.sh`**: `sh run-unix-sidecar.sh [--require <cmd>]... [--hint <text>] -- <command> [args]`. An
  application started from the Finder does not get the PATH of the user's login shell (Homebrew, nvm, `~/.local/bin`, the AI CLIs
  an agent runs): the script reads the login shell's PATH once, adds the usual directories, checks the `--require`d commands
  (`tmux`, `git`...) and `exec`s the command. A missing prerequisite is written to the sidecar log with the hint and the script
  exits with code 3; with `"optional": true` the app starts without the sidecar. Declare it with `"command": "/bin/sh"` and the
  script as first argument (no executable bit needed in the packaged resources).
- **Windows, `run-in-wsl.ps1`**: for a sidecar that needs Linux. See below.

Prerequisites the sidecar's own tools need are the project's to document; the shell and the launchers never install anything.

### Windows: sidecars inside WSL2

The application, its back (SQLite, local trust) and its interface are native Windows. A sidecar that needs Linux (a runner using
`tmux` and `node-pty`) runs in the user's WSL2 distribution through `run-in-wsl.ps1`, declared as a Windows-only optional sidecar:

```json
{ "name": "runner-wsl", "optional": true, "os": ["windows"], "command": ["powershell.exe"],
  "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "{resources}/launchers/run-in-wsl.ps1",
           "-Name", "runner", "-Payload", "{resources}/runner/runner-linux.tgz", "-Entry", "dist/main.js",
           "-Requires", "tmux,git", "-HealthUrl", "http://127.0.0.1:{port:server}/api/v1/health",
           "-ForwardEnv", "HUB_URL,RUNNER_TOKEN"],
  "env": { "HUB_URL": "ws://127.0.0.1:{port:server}/api/v1/agenthub/ws/runner" }, "sharedToken": "RUNNER_TOKEN" }
```

At each launch the script: (1) checks `wsl.exe --status` and that a distribution exists (`VX_WSL_DISTRO` picks one, default
distribution otherwise); (2) inside it checks Node >= `-NodeMin` (22), the `-Requires` commands and that the Windows-hosted back
answers at `-HealthUrl` **from WSL**; (3) unpacks the Linux payload (`.tgz`, built by CI for linux-x64) once per version under
`~/.vx-desktop/<Name>/<sha>` of the distribution; (4) forwards the `-ForwardEnv` variables (through `WSLENV`) and starts
`node <Entry>` attached, so its output is the sidecar log and stopping the app ends it. Any unmet prerequisite is printed with what
to do and the script exits with code 3: the app then starts without the sidecar.

- **Reaching the back from WSL.** The back listens on `127.0.0.1` only (local trust refuses anything else, by design: never weaken
  it) and the Windows loopback is not reachable from WSL2's default NAT network. WSL must use **mirrored networking** (Windows 11
  22H2+, WSL 2.0+): `%UserProfile%\.wslconfig` with `[wsl2]` / `networkingMode=mirrored`, then `wsl --shutdown`. The launcher checks
  this and prints exactly that when it is not the case. A relay that exposed the back on the WSL network was rejected: a forwarded
  connection would reach the back from the loopback and be granted the local administrator.
- **Paths.** The runner lives and works in the distribution (`~/projects` of its Linux user, its state under `~/.agenthub-runner`
  or the project's `STATE_DIR`): a pty and tmux sockets need a Linux file system, never `/mnt/c`.
- **Tmux outlives the app**: the tmux server of the runner keeps running in WSL after the app is closed (the runner re-attaches to
  its sessions at the next launch, like on macOS/Linux).
- **Not tested**: written without a Windows machine (PowerShell cannot be run here). `powershell.exe` 5.1 argument passing,
  `wsl.exe` output encoding (UTF-16, handled), `wslpath` quoting and mirrored networking must be exercised on a real Windows 11.

## Desktop variant (an app that uses the `user` module and PostgreSQL on the web)

The shell runs the back with `LOCAL_TRUST=true` and `DB_ENGINE=sqlite`: it refuses a project that uses the `user` module or
another database. An application that needs both on the web can still ship a standalone desktop app by declaring a **variant**: the
same application built with another set of shared modules (no `user`, nothing PostgreSQL-only), the web build being untouched.

```jsonc
// project.config.json
{ "desktop": { "enabled": true, "variant": {
    "sharedModules": "shared-modules.desktop.json",          // same format as shared-modules.json
    "packageLocal": { "front": "front/package.local.desktop.json" },   // optional (see below)
    "prune": ["back/src/modules/app/llm"]                    // optional: folders deleted from the STAGED sources
} } }
```

The same fields can be written in a descriptor file instead (`"variant": { "descriptor": "desktop-flavor.json" }`), and a
`desktop-flavor.json` at the project root is found by convention, even in a project that has no `project.config.json` (created
before the wizard). Explicit fields win over the descriptor. `<stack>/package.local.desktop.json`, when it exists, is the overlay of
that stack without any declaration.

- **Validation** (`add-desktop.mjs`, `node scripts/desktop/variant.mjs check`): the module list has no `user`; every listed module
  supports SQLite (`databases` absent or containing `sqlite` in its `module.json`); every `requires` of a listed module is listed;
  the files named by the variant exist. Without a variant the historical refusal stays (and now points at the variant).
  `node scripts/add-desktop.mjs --variant <file>` declares it from the command line (a descriptor or a module list).
- **Build** (`app.sh`, `bundle.sh`, `node scripts/desktop/variant.mjs stage`): the back and the front are built in an **isolated
  copy** of the project, `desktop/build/variant/` (gitignored with the rest of `desktop/build/`): the sources without
  `node_modules`, `dist`, `.git` or any `.env*`; a **real copy** of the library checkouts (Node resolves dependencies from the real path
  of a file); `shared-modules.json` = the variant's list; `package.json` regenerated by `build-package.mjs` from the stack's
  `package.local.json` **merged with the overlay**; its own `node_modules`; `link-shared` run in the copy. Then `npm run build`
  in each stack. The developer's `src/modules_shared` symlinks, `package.json`, `node_modules` and `.env*` are never read or written
  (checked by a test: the tree is identical before and after). `build-desktop.mjs` reads `back/dist`, `front/dist` and
  `back/package*.json` from that copy (`--build-root`), `desktop.config.json` and the extra resources from the project.
  `variant.mjs stage` options: `--no-install`, `--no-build`, `--clean`, `--update-lock`.
- **Dependencies of the variant.** The modules the variant drops used to bring dependencies the application may rely on without
  declaring them (a front using TanStack Query provided by the `user` module's plugin, a `zod` that only resolved because of a
  hoisted transitive copy): the stage compile fails with *Cannot find module*. Declare them in the overlay. Pin the variant's
  dependencies with `back/package-lock.desktop.json` (`stage --update-lock` writes it from the stage); without it the stage runs
  `npm install` and warns.
- **Runtime parts the dropped modules provided** (a `QueryClientProvider`, an identity) are the application's to supply in the
  variant: the shell only builds and runs it.

## Downloads

`<a download>` links are saved to the Downloads folder by the shell, which then fires the `desktop-download` event on
`window` (`detail: { path, success }`). Mount `useDesktopDownloads()` from `react/common` once in the front layout to get a
toast (`react/common/README.md`); without it the shell shows a small fallback notification.

## Development

```bash
cd desktop && npm install                       # once: installs @tauri-apps/cli
# build the project's back and front (back/dist, front/dist), then from desktop/:
DESKTOP_RESOURCES=<project root> npm run dev    # Rust toolchain required (rustup)
```

`DESKTOP_RESOURCES=<project root>` makes the repository itself the resources folder (the layout is the same), so the shell
uses `back/dist`, `back/node_modules`, `front/dist` and the system `node`. `DESKTOP_CONFIG=<file>` replaces the embedded
config at run time. Pure logic (config parsing, environment, resources detection, log rotation, health probe, process
stop) is covered by `cargo test` in `src-tauri/`; `npm test` runs the Node tests of the sync script. Rust builds are heavy:
no `cargo build --release` or `tauri build` needed for development.

## Build and package scripts

Two entry points from the project root wrap the steps below (they are what most projects need):

| Script | Does |
|---|---|
| `./scripts/app.sh` | Builds the app for **this machine** and launches it. macOS: `<Product>.app` (no DMG), opened with `open` after stopping a running copy (single instance). Linux / Windows (Git Bash): the shell binary only (`--bundles none`), run with `DESKTOP_RESOURCES` on the resources folder. `--no-run` (build only; `npm run desktop:build` from `back/`), `--no-build` (launch the last build), `--clean`. |
| `./scripts/bundle.sh` | Distributable packages, copied to `desktop/dist/`. Default targets: this machine, `win-x64` and `linux-x64` (`--targets a,b` to choose). This machine: native installer (`tauri build`: macOS `.dmg`, Linux `.deb` + `.AppImage`, Windows NSIS). Other OS: portable archive by `package-cross.mjs`. A target whose tools are missing (mingw-w64 + `zip` for Windows from macOS/Linux, a running Docker for Linux from macOS/Windows; macOS only on a Mac) is skipped with the reason. Exit 1 when a target failed, or when a target named by `--targets` was skipped. `--clean`. |

Both, in order: `npm ci` in `back/`, `front/`, `desktop/` when `node_modules` is missing; `npm run build` in `back/` and `front/`;
the **prepare hook** of the project; `build-desktop.mjs --target <t> --out desktop/build/resources-<t>` (one resources folder per
target, so a target never reuses another platform's `node_modules`; `--skip-install` is passed while `back/package-lock.json` is
unchanged since the last assembly of that target). Shared steps: `scripts/desktop/common.sh`.

**Prepare hook** (optional, project-owned, executable): `scripts-local/desktop-prepare.sh <target>` (or `DESKTOP_PREPARE_HOOK`),
run from the project root before the assembly of each target. It builds what `packaging.extraResources` copies (an embedded
engine for that platform...). `DESKTOP_CLEAN=1` (set by `--clean`) asks it for a full rebuild; a non-zero exit stops that target.

## Packaging

Scripts live in `scripts/desktop/` (zero npm dependencies; run from the project root, `scripts` being the template's
folder). Everything project-specific stays in `desktop.config.json`.

```bash
node scripts/desktop/build-desktop.mjs --dry-run                 # print the plan, download and write nothing
node scripts/desktop/build-desktop.mjs --bundle                  # this machine: resources, then tauri build (+ DMG on macOS)
node scripts/desktop/build-desktop.mjs --target win-x64          # resources for another platform
node scripts/desktop/package-cross.mjs --target win-x64          # portable zip (or linux-x64 / linux-arm64: tar.gz)
```

Build the project first (`back/dist`, `front/dist`).

**`build-desktop.mjs`** (`--root`, `--target`, `--out`, `--node-version`, `--cache-dir`, `--version`, `--skip-install`,
`--no-sign`, `--bundle`, `--bundles` (`none`: shell binary only), `--no-dmg`, `--dry-run`) assembles `desktop/build/resources/`:

| Folder | Content |
|---|---|
| `back/dist`, `back/package.json` | compiled back, source maps and `.d.ts` removed |
| `back/src/...` | locale JSONs (`src/locales`, `modules*/**/locales/*.json`), same collection as `back/Dockerfile` |
| `back/node_modules` | `npm ci --omit=dev --ignore-scripts` (with `--os/--cpu` when the target is another platform) |
| `front/dist` (`resources.frontDir`) | built front |
| `runtime/node/node[.exe]` | official Node of the pinned version (`NODE_VERSION` in `lib.mjs`, or `packaging.nodeVersion`, or `--node-version`); the pin is the latest 22.x published at least two weeks earlier, to be bumped on that rule, SHA-256 checked against the release `SHASUMS256.txt` (the GPG signature of that file is not verified) |
| `packaging.extraResources` | the folders you declare, e.g. a sidecar engine |

`better-sqlite3`: `prebuild-install --runtime node --target <node version> --platform <os> --arch <cpu>` is run in its
folder (the method of the package's own `install` script), so the binary matches the target platform, CPU and the
Node ABI of the embedded runtime. No compiler is needed when a prebuilt binary exists for the target.

`packaging` in `desktop.config.json` (ignored by the shell):

```json
"packaging": { "nodeVersion": null, "extraResources": ["engine", { "from": "engine/dist", "to": "engine" }] }
```

An entry is a path relative to the project root (copied to the same path in the resources) or `{ from, to }`. `back`,
`front` and `runtime` are owned by the build. Sidecar commands then reference `{resources}/<to>/...`.

**Native modules of the back.** After assembly every `back/node_modules/**/*.node` is listed. `better-sqlite3` is handled; any other
package (for example `sharp`) is reported as *unverified*, and as *mismatch* when its binary is for another OS or CPU
than the target (common when cross-building). The build does not fix them: a project with such a dependency must
provide the target binary itself, or the packaging is not usable as is.

**Native modules of a sidecar** (`packaging.extraResources`): the build copies the folders as they are and does not inspect them.
A sidecar that ships a native module (a runner with `node-pty`, say) must bring the binary for the target in its payload, built
by the project's prepare hook (`scripts-local/desktop-prepare.sh <target>`, run once per target before the assembly). What a CI
has to do for such a module: if the package ships prebuilt binaries for the target platform and CPU (`node-pty` 1.1: darwin-arm64,
darwin-x64, win32-x64, win32-arm64), `npm ci --omit=dev` on any host is enough and the hook only keeps the target's folder; if it does
not (`node-pty` on Linux), the module is compiled with node-gyp (python3, make, g++) on a host of the **same OS and CPU as the
target**, so one CI job per such target (the workflow does it: `linux-x64`; `linux-arm64` needs an arm64 runner). A Windows target whose
sidecar runs in WSL2 needs the **Linux** payload: the Linux job builds it (hook `scripts-local/desktop-payloads.sh`) and uploads it as
the `desktop-payloads` artifact, the Windows job downloads it into `desktop/build/payloads/`. Embedded Node is the target's own
(`runtime/node/node`); a payload runs with it, except in WSL2 where it runs with the distribution's Node.

**Version.** One source: `version` of `project.config.json`, else `back/package.json`; `--version` overrides. The
sync script (`npm run sync`, run by `dev`/`build`) writes it into `tauri.conf.json` and `Cargo.toml`, and the DMG and
archive names use it (`<Product>_<version>_<arch>.dmg`, `<Product>-<version>-<target>.zip|tar.gz`).

**Tauri bundle.** `--bundle` passes the resources to `tauri build` in an override file, `tauri build --config
desktop/build/tauri.override-<target>.json` (absolute paths; the CLI ignores the `TAURI_CONFIG` variable), so `tauri.conf.json` stays valid for `tauri dev`. Default bundles: `app` (macOS), `deb,appimage`
(Linux), `nsis` (Windows). Icons: `bundle.icon` points to a placeholder; run `tauri icon <logo>` for the project.

**macOS DMG.** `scripts/desktop/make-dmg.sh --app <App.app> --out <file.dmg> [--name <volume>]` (hdiutil, no Finder);
run by `--bundle`.

**Portable Windows / Linux.** `package-cross.mjs` writes `<Product>-<version>-<target>.zip` (needs `zip`) or
`.tar.gz` (Linux, with `launch.sh`), a README and the `.sha256` file, into `desktop/dist/`. The shell is cross-built
unless `--shell-binary` is given: Windows with mingw-w64 (`x86_64-pc-windows-gnu`), Linux in a Docker container.
Resources for the target must have been assembled with the same `--target`; for Linux, on a case-sensitive file system.

## Signing and notarization (described, not automated)

- **macOS, default**: ad hoc signature (`signingIdentity: "-"`; every Mach-O file of the resources is signed, then the
  app with `codesign --force --deep --sign -`). A downloaded app is quarantined by Gatekeeper: right click, Open, or
  `xattr -dr com.apple.quarantine "/Applications/<Product>.app"`.
- **macOS, public distribution**: a "Developer ID Application" certificate (Apple Developer account), hardened runtime
  (`bundle.macOS.hardenedRuntime: true` and entitlements for the embedded Node: `com.apple.security.cs.allow-jit`,
  `allow-unsigned-executable-memory`), signing of the nested binaries, then
  `xcrun notarytool submit <file.dmg> --apple-id ... --team-id ... --password ... --wait` and
  `xcrun stapler staple <file.dmg>`. In CI the certificate and credentials come from secrets.
- **Windows**: the portable `.exe` is unsigned and triggers SmartScreen. An Authenticode certificate (OV/EV or a signing
  service) and `signtool sign /fd SHA256 /tr <timestamp url> <exe>` remove the warning; Tauri can sign the NSIS installer
  through `bundle.windows.signCommand`.
- **Linux**: no signature required.

## CI

`template/.github/workflows/build-desktop.yml` is a skeleton: a `payloads` job (Linux, runs `scripts-local/desktop-payloads.sh` when the
project has it: Linux-only payloads other builds reuse) and a `build` matrix (macOS arm64 `macos-14`, macOS x64 `macos-15-intel`, Windows
`windows-2022` with `nsis,msi`, Linux `ubuntu-22.04` with `deb,appimage`) that runs `scripts/bundle.sh --targets <target>` (variant stage,
prepare hook, resources, Tauri bundle) and uploads `desktop/dist/*` (`.dmg`, `.deb`, `.AppImage`, NSIS `.exe`, `.msi`). `DESKTOP_BUNDLES`
overrides the host target's bundle list. The Windows job enables `core.symlinks` first (the repository relies on symlinks). It is copied into a project only when the desktop option is chosen
(`create-project.mjs --desktop` or `scripts/add-desktop.mjs`). It has never run on GitHub Actions.

## Possible evolution

- **Automatic update**: `tauri-plugin-updater` (signed update manifest, a hosting place for it, the key pair). Not
  started; it needs a release process the template does not impose.
- Notarization and Windows signing in the CI workflow.

## Adding the shell to a project

- New project: `create-project.mjs --desktop [--desktop-name <text>] [--desktop-identifier <reverse.domain>]`, or answer
  yes to « Desktop application (Tauri)? » (asked before the database: SQLite becomes the default, multi-user is not asked, local
  trust is proposed). The answers are saved in the `desktop` section of `project.config.json`
  (`{ enabled, productName, identifier, sidecars: [] }`); `productName` defaults to the site name, `identifier` to
  `com.example.<project name>` (a placeholder: it names the OS data folder, choose your own).
- Existing project: `node scripts/add-desktop.mjs [--name ...] [--identifier ...] [--dry-run]`.
- Both copy this folder (without `node_modules`, `build`, `target`, `src-tauri/gen`) and the workflow, fill `desktop.config.json`
  (`productName`, `identifier`, `sidecars`) and sync `tauri.conf.json`, and add `desktop:dev` / `desktop:build` (= `scripts/app.sh
  --no-run`) to `back/package.local.json` (run them from `back/`; both need the Rust toolchain).
- Refused with the `user` module (the shell forces `LOCAL_TRUST=true`) or a database other than SQLite (it forces
  `DB_ENGINE=sqlite`) **unless the project declares a desktop variant** (see above), with an invalid identifier, and when `desktop/` or the workflow already exists (nothing is
  overwritten). Once installed, `desktop/desktop.config.json` is the source of truth: the `desktop` section of
  `project.config.json` only records the answers.
- CI: `tools/ci-sandbox.sh anonymous-sqlite-desktop` checks the generation (files, configs, scripts, `build-desktop.mjs --dry-run`)
  and never compiles Rust.

## Not done yet

- Not verified here: a real window launch (the shell was compiled and unit-tested only), and a real packaging run
  (no download, no assembly, no `tauri build`, no signing was performed; only pure functions and `--dry-run`).
