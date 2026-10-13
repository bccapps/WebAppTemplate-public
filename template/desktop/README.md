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
| `server` | The back. `command` (string or candidate list), `args`, `cwd`, `env`, `healthPath` (default `/api/v1/health`), `readyTimeoutSec` (default 120), `sharedToken`. |
| `sidecars[]` | Same shape as `server`, plus `name` (required, unique, not `server`), `label`, `port`. Started in order **before** the server. |
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
- `sharedToken`: name of an env var that receives a token generated at **each launch** (32 random bytes in hex), the
  same value for every process that asks, e.g. `"sharedToken": "ENGINE_TOKEN"` on both the server and an engine sidecar
  so the back can authenticate to it.

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
   `LOCAL_TRUST=true`, `DATABASE_ENGINE=sqlite`, `DB_PATH=<data>/<dbFile>`, `DB_MIGRATIONS_RUN=true`,
   `APP_DATA_DIR=<data>`, `LOG_DIR=<data>/logs`, `SHARED_DIRECTORY=<data>/shared`, `DISABLE_TRANSPORT_CRYPTO=true`,
   `APP_ENV=desktop`, `SERVE_FRONT_DIR`, `DESKTOP_PARENT_PID` (the shell pid; the back exits when it disappears, see
   `nest/common/README.md`). Sidecars receive only their config `env` plus the shared token.
5. Sidecars, then the server, are started in their own process group; the shell waits for each health path; the window
   then goes to the front. If a process exits during start-up, or the health wait times out, the waiting page shows the
   error and the last 40 log lines. If one dies later, the window returns to the waiting page with the same details.
6. **Shutdown** (window closed, SIGTERM/SIGINT/SIGHUP): the groups get `SIGTERM`, then `SIGKILL` after 6 s (Windows:
   `taskkill /T /F`). Safety nets if the shell itself is killed: a detached sentinel process on Unix, a Job Object with
   kill-on-close on Windows.
7. Also: single instance (a second launch focuses the window), window built in code (downloads, no drag-and-drop
   interception), Linux DMA-BUF workaround.

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
`--no-sign`, `--bundle`, `--bundles`, `--dry-run`) assembles `desktop/build/resources/`:

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

**Native modules.** After assembly every `node_modules/**/*.node` is listed. `better-sqlite3` is handled; any other
package (for example `sharp`) is reported as *unverified*, and as *mismatch* when its binary is for another OS or CPU
than the target (common when cross-building). The build does not fix them: a project with such a dependency must
provide the target binary itself, or the packaging is not usable as is.

**Version.** One source: `version` of `project.config.json`, else `back/package.json`; `--version` overrides. The
sync script (`npm run sync`, run by `dev`/`build`) writes it into `tauri.conf.json` and `Cargo.toml`, and the DMG and
archive names use it (`<Product>_<version>_<arch>.dmg`, `<Product>-<version>-<target>.zip|tar.gz`).

**Tauri bundle.** `--bundle` passes the resources to `tauri build` through the `TAURI_CONFIG` environment variable
(absolute paths), so `tauri.conf.json` stays valid for `tauri dev`. Default bundles: `app` (macOS), `deb,appimage`
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

`template/.github/workflows/build-desktop.yml` is a skeleton (macOS arm64 and x64, Windows, Linux) that runs
`build-desktop.mjs --bundle` and uploads the bundles. It is copied into a project only when the desktop option is chosen
(G3). It has never run on GitHub Actions.

## Possible evolution

- **Automatic update**: `tauri-plugin-updater` (signed update manifest, a hosting place for it, the key pair). Not
  started; it needs a release process the template does not impose.
- Notarization and Windows signing in the CI workflow.

## Not done yet (G3)

- **G3 wizard**: the "desktop app" question of `create-project`, `desktop` entry in `project.config.json` (generating
  `desktop.config.json` from it), `scripts/add-desktop.mjs` for existing projects, the `desktop:dev` / `desktop:build`
  npm scripts.
- Not verified here: a real window launch (the shell was compiled and unit-tested only), and a real packaging run
  (no download, no assembly, no `tauri build`, no signing was performed; only pure functions and `--dry-run`).
