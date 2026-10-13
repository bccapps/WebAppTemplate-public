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
  scripts/sync-tauri-config.mjs   # desktop.config.json -> src-tauri/tauri.conf.json (+ optional version)
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

## Not done yet (G2 / G3)

- **G2 packaging**: downloading and verifying the Node runtime, assembling `back/dist` + production `node_modules` +
  `front/dist` into the resources folder, `better-sqlite3` native binary for the target, `tauri.conf.json`
  `bundle.resources`, DMG, Windows/Linux packages, CI workflow, signing and notarization, icons (`bundle.icon` points to
  a placeholder `src-tauri/icons/icon.png`; use `tauri icon` with the project logo).
- **G3 wizard**: the "desktop app" question of `create-project`, `desktop` entry in `project.config.json` (generating
  `desktop.config.json` from it), `scripts/add-desktop.mjs` for existing projects, the `desktop:dev` / `desktop:build`
  npm scripts.
- Not verified here: a real window launch (the shell was compiled and unit-tested only).
