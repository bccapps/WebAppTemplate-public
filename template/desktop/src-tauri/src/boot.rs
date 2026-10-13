// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Start-up sequence: resources, data folder, secrets, ports, sidecars, server, health wait, then the front;
//! afterwards a watchdog sends the window back to the waiting page if a process dies.

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::config::{DesktopConfig, ProcessConfig, SERVER_NAME};
use crate::environment::{ensure_secrets, process_env, random_key_b64, random_token_hex, server_core_env, substitute, Placeholders, ServerFacts};
use crate::health::{free_ports, http_ok};
use crate::logs::{open_rotated_log, shell_log, tail};
use crate::process::{spawn_process, Managed, Processes, SpawnSpec};
use crate::resources::{pick_command, pick_resources_dir, RESOURCES_ENV};
use crate::splash::{error_js, eval, init_js, merged_texts, status_js, Params};

const SPLASH_LOAD_DELAY: Duration = Duration::from_millis(900);
const SLOW_START_AFTER: Duration = Duration::from_secs(8);
const LOG_TAIL_LINES: usize = 40;

/// A start-up failure, shown on the waiting page (ids are translated by the page).
pub struct BootError {
    title: &'static str,
    detail: &'static str,
    params: Params,
    log: String,
}

impl BootError {
    fn new(id: &'static str, params: Params) -> Self {
        let (title, detail) = match id {
            "badConfig" => ("title.badConfig", "detail.badConfig"),
            "noResources" => ("title.noResources", "detail.noResources"),
            "noDataDir" => ("title.noDataDir", "detail.noDataDir"),
            "noPort" => ("title.noPort", "detail.noPort"),
            "secrets" => ("title.secrets", "detail.secrets"),
            "spawnFailed" => ("title.spawnFailed", "detail.spawnFailed"),
            "exitedAtStart" => ("title.exitedAtStart", "detail.exitedAtStart"),
            "timeout" => ("title.timeout", "detail.timeout"),
            _ => ("title.died", "detail.died"),
        };
        Self { title, detail, params, log: String::new() }
    }

    fn with_log(mut self, log: String) -> Self {
        self.log = log;
        self
    }

    fn show(&self, app: &AppHandle) {
        eval(app, error_js(self.title, self.detail, &self.params, &self.log));
    }
}

fn param(k: &str, v: impl ToString) -> (String, String) {
    (k.to_string(), v.to_string())
}

/// Everything resolved before any process starts.
struct Context {
    resources: PathBuf,
    data_dir: PathBuf,
    logs_dir: PathBuf,
    ports: BTreeMap<String, u16>,
    secrets: BTreeMap<String, String>,
    token: String,
}

impl Context {
    fn placeholders(&self, own: &str) -> Placeholders {
        Placeholders {
            resources: self.resources.clone(),
            data_dir: self.data_dir.clone(),
            logs_dir: self.logs_dir.clone(),
            own_port: self.ports.get(own).copied(),
            ports: self.ports.clone(),
        }
    }
}

fn find_resources(app: &AppHandle, cfg: &DesktopConfig) -> Option<PathBuf> {
    let override_dir = env::var_os(RESOURCES_ENV).map(PathBuf::from);
    // Portable layout (Windows/Linux): resources sit next to the executable. Packaged layout: Tauri's resource dir.
    let exe_dir = env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let candidates: Vec<PathBuf> = exe_dir.into_iter().chain(app.path().resource_dir().ok()).collect();
    pick_resources_dir(override_dir, &candidates, &cfg.resources.marker, &|p| p.is_file())
}

fn prepare(app: &AppHandle, cfg: &DesktopConfig) -> Result<Context, BootError> {
    let resources = find_resources(app, cfg).ok_or_else(|| BootError::new("noResources", vec![]))?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| BootError::new("noDataDir", vec![param("detail", e)]))?;
    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| BootError::new("noDataDir", vec![param("detail", e)]))?;
    let secrets = ensure_secrets(&data_dir.join("secrets.json"), &random_key_b64)
        .map_err(|e| BootError::new("secrets", vec![param("detail", e)]))?;
    let ports = allocate_ports(cfg).map_err(|e| BootError::new("noPort", vec![param("detail", e)]))?;
    Ok(Context { resources, data_dir, logs_dir, ports, secrets, token: random_token_hex() })
}

fn all_processes(cfg: &DesktopConfig) -> Vec<&ProcessConfig> {
    cfg.sidecars.iter().chain(std::iter::once(&cfg.server)).collect()
}

fn allocate_ports(cfg: &DesktopConfig) -> std::io::Result<BTreeMap<String, u16>> {
    let wanting: Vec<&ProcessConfig> = all_processes(cfg).into_iter().filter(|p| p.port).collect();
    let ports = free_ports(wanting.len())?;
    Ok(wanting.iter().map(|p| p.name().to_string()).zip(ports).collect())
}

fn spawn_spec(cfg: &DesktopConfig, p: &ProcessConfig, ctx: &Context) -> Result<SpawnSpec, BootError> {
    let ph = ctx.placeholders(p.name());
    let fail = |detail: String| BootError::new("spawnFailed", vec![param("name", p.label()), param("detail", detail)]);
    let candidates: Vec<String> = p.command.candidates().iter().map(|c| substitute(c, &ph)).collect();
    let command = pick_command(&candidates, &|path| path.is_file()).ok_or_else(|| fail(format!("command not found: {}", candidates.join(", "))))?;
    let log_path = ctx.logs_dir.join(format!("{}.log", p.name()));
    let log = open_rotated_log(&log_path).map_err(&fail)?;
    let extra = (p.name() == SERVER_NAME).then(|| server_core_env(&server_facts(cfg, ctx)));
    let env = process_env(p, &ph, &ctx.token, extra.as_ref().map(|core| (&ctx.secrets, core)));
    Ok(SpawnSpec {
        command,
        args: p.args.iter().map(|a| substitute(a, &ph)).collect(),
        cwd: p.cwd.as_ref().map(|c| PathBuf::from(substitute(c, &ph))),
        env,
        log,
    })
}

fn server_facts<'a>(cfg: &'a DesktopConfig, ctx: &'a Context) -> ServerFacts<'a> {
    ServerFacts {
        port: ctx.ports[SERVER_NAME],
        data_dir: &ctx.data_dir,
        logs_dir: &ctx.logs_dir,
        front_dir: ctx.resources.join(&cfg.resources.front_dir),
        db_file: &cfg.db_file,
        parent_pid: std::process::id(),
    }
}

/// Outcome of looking at a managed process.
enum Liveness {
    Running,
    Exited(ExitStatus),
    /// Removed from the state: the application is shutting down.
    Gone,
}

fn liveness(app: &AppHandle, name: &str) -> Liveness {
    let state = app.state::<Processes>();
    let mut list = state.0.lock().unwrap();
    match list.iter_mut().find(|m| m.name == name) {
        None => Liveness::Gone,
        Some(m) => m.child.try_wait().ok().flatten().map_or(Liveness::Running, Liveness::Exited),
    }
}

/// Polls the health path of a started process until it answers, exits, or times out.
fn wait_ready(app: &AppHandle, p: &ProcessConfig, ctx: &Context) -> Result<bool, BootError> {
    let (Some(path), Some(port)) = (&p.health_path, ctx.ports.get(p.name())) else {
        return Ok(true);
    };
    let log_path = ctx.logs_dir.join(format!("{}.log", p.name()));
    let started = Instant::now();
    let mut announced = false;
    loop {
        thread::sleep(Duration::from_millis(250));
        match liveness(app, p.name()) {
            Liveness::Gone => return Ok(false),
            Liveness::Exited(status) => return Err(exited_at_start(p, status, &log_path)),
            Liveness::Running => {}
        }
        if http_ok(*port, path) {
            return Ok(true);
        }
        if started.elapsed() > Duration::from_secs(p.ready_timeout_sec) {
            let params = vec![param("name", p.label()), param("seconds", p.ready_timeout_sec), param("log", log_path.display())];
            return Err(BootError::new("timeout", params).with_log(tail(&log_path, LOG_TAIL_LINES)));
        }
        if !announced && started.elapsed() > SLOW_START_AFTER {
            announced = true;
            eval(app, status_js("status.slowStart", &vec![]));
        }
    }
}

fn exited_at_start(p: &ProcessConfig, status: ExitStatus, log_path: &Path) -> BootError {
    let params = vec![param("name", p.label()), param("code", status), param("log", log_path.display())];
    BootError::new("exitedAtStart", params).with_log(tail(log_path, LOG_TAIL_LINES))
}

/// Starts one process, registers it, and waits for its health when it has one. `false`: shutdown requested.
fn start_process(app: &AppHandle, cfg: &DesktopConfig, p: &ProcessConfig, ctx: &Context) -> Result<bool, BootError> {
    eval(app, status_js("status.startingProcess", &vec![param("name", p.label())]));
    let spec = spawn_spec(cfg, p, ctx)?;
    let log_path = ctx.logs_dir.join(format!("{}.log", p.name()));
    let child = spawn_process(spec).map_err(|e| {
        BootError::new("spawnFailed", vec![param("name", p.label()), param("detail", e)]).with_log(tail(&log_path, LOG_TAIL_LINES))
    })?;
    let managed = Managed { name: p.name().to_string(), label: p.label().to_string(), child };
    app.state::<Processes>().0.lock().unwrap().push(managed);
    wait_ready(app, p, ctx)
}

fn start_all(app: &AppHandle, cfg: &DesktopConfig, ctx: &Context) -> Result<bool, BootError> {
    for p in all_processes(cfg) {
        if !start_process(app, cfg, p, ctx)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn window_url(app: &AppHandle) -> Option<String> {
    app.get_webview_window("main").and_then(|w| w.url().ok()).map(|u| u.to_string())
}

/// If a process dies mid-session, go back to the waiting page with its log. Returns when the app shuts down.
fn watch(app: &AppHandle, ctx: &Context, splash_url: Option<String>) {
    loop {
        thread::sleep(Duration::from_secs(1));
        let dead = {
            let state = app.state::<Processes>();
            let mut list = state.0.lock().unwrap();
            if list.is_empty() {
                return;
            }
            list.iter_mut().find_map(|m| m.child.try_wait().ok().flatten().map(|s| (m.name.clone(), m.label.clone(), s)))
        };
        if let Some((name, label, status)) = dead {
            if let Some(url) = splash_url {
                eval(app, format!("window.location.replace({})", crate::splash::js_str(&url)));
                thread::sleep(SPLASH_LOAD_DELAY);
            }
            let log_path = ctx.logs_dir.join(format!("{name}.log"));
            let params = vec![param("name", label), param("code", status), param("log", log_path.display())];
            BootError::new("died", params).with_log(tail(&log_path, LOG_TAIL_LINES)).show(app);
            return;
        }
    }
}

fn run(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), BootError> {
    let ctx = prepare(app, cfg)?;
    shell_log(&ctx.logs_dir, &format!("resources: {}", ctx.resources.display()));
    if !start_all(app, cfg, &ctx)? {
        return Ok(());
    }
    let splash_url = window_url(app);
    let url = format!("http://127.0.0.1:{}/", ctx.ports[SERVER_NAME]);
    eval(app, format!("window.location.replace({})", crate::splash::js_str(&url)));
    watch(app, &ctx, splash_url);
    Ok(())
}

/// Entry point of the start-up thread.
pub fn boot(app: AppHandle, cfg: Arc<DesktopConfig>) {
    // Let the webview load the waiting page before sending it messages.
    thread::sleep(SPLASH_LOAD_DELAY);
    match merged_texts(&cfg.splash.texts) {
        Ok(texts) => eval(&app, init_js(&cfg.product_name, &cfg.splash.brand, &texts)),
        Err(e) => return BootError::new("badConfig", vec![param("detail", e)]).show(&app),
    }
    eval(&app, status_js("status.starting", &vec![]));
    if let Err(e) = run(&app, &cfg) {
        e.show(&app);
    }
}
