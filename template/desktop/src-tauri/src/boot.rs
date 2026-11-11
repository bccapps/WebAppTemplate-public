// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Start-up sequence: resources, data folder, secrets, ports, sidecars, server, health wait, then the front;
//! afterwards a watchdog sends the window back to the waiting page if a process dies.

use std::collections::{BTreeMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::config::{DesktopConfig, ProcessConfig, SERVER_NAME};
use crate::environment::{
    constant_time_eq, ensure_secrets, link_tokens, process_env, random_key_b64, random_token_hex, server_core_env, shell_proof, substitute, ui_boot_code,
    window_url, LaunchTokens, Placeholders, ServerFacts,
};
use crate::health::{free_ports, http_get, http_ok};
use crate::navigation::{back_origin, set_back_origin};
use crate::logs::{open_rotated_log, shell_log, tail};
use crate::process::{spawn_process, Managed, Processes, SpawnSpec};
use crate::resources::{pick_command, pick_resources_dir, RESOURCES_ENV};
use crate::sidecar_message::{Endpoint, SidecarEndpoints};
use crate::splash::{error_js, eval, init_js, merged_texts, status_js, Params};

const SPLASH_LOAD_DELAY: Duration = Duration::from_millis(900);
const SLOW_START_AFTER: Duration = Duration::from_secs(8);
const LOG_TAIL_LINES: usize = 40;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_config;

    const CFG: &str = r#"{"productName":"A","identifier":"x","server":{"command":"n"},"sidecars":[
        {"name":"mac","command":"p","os":["macos","linux"],"optional":true},
        {"name":"win","command":"p","os":["windows"]},
        {"name":"any","command":"p"}]}"#;

    #[test]
    fn processes_are_filtered_by_os_with_the_server_last() {
        let cfg = parse_config(CFG).unwrap();
        let names = |os: &str| processes_for(&cfg, os).iter().map(|p| p.name().to_string()).collect::<Vec<_>>();
        assert_eq!(names("macos"), vec!["mac", "any", "server"]);
        assert_eq!(names("windows"), vec!["win", "any", "server"]);
        assert_eq!(names("linux"), vec!["mac", "any", "server"]);
    }

    #[test]
    fn sidecar_message_is_granted_to_the_numeric_loopback_origin_of_the_back_only() {
        assert_eq!(back_capability_urls(4321), vec!["http://127.0.0.1:4321/*".to_string()]);
    }

    #[test]
    fn only_a_reply_with_the_right_proof_is_the_back() {
        use crate::sidecar_message::SidecarReply;
        let reply = |status: u16, proof: &str| Ok(SidecarReply { status, body: serde_json::json!({ "proof": proof }) });
        let good = shell_proof("key", "nonce");
        assert_eq!(judge_proof(reply(200, &good), "key", "nonce"), BackProof::Proven);
        assert_eq!(judge_proof(reply(200, &good), "other-key", "nonce"), BackProof::Refused);
        assert_eq!(judge_proof(reply(200, &shell_proof("key", "replayed")), "key", "nonce"), BackProof::Refused);
        assert_eq!(judge_proof(reply(200, ""), "key", "nonce"), BackProof::Refused);
        assert_eq!(judge_proof(reply(401, &good), "key", "nonce"), BackProof::Refused);
        assert_eq!(judge_proof(reply(404, ""), "key", "nonce"), BackProof::Legacy);
        assert_eq!(judge_proof(Err("closed".into()), "key", "nonce"), BackProof::Refused);
    }

    #[test]
    fn optional_names_only_cover_the_running_processes() {
        let cfg = parse_config(CFG).unwrap();
        let optional = optional_names(&cfg);
        assert!(optional.is_empty() || optional.contains("mac"));
        assert!(!optional.contains("server") && !optional.contains("any"));
    }
}

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
            "notProven" => ("title.notProven", "detail.notProven"),
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
    tokens: LaunchTokens,
    /// The interface boot code of this launch: only ever put in the fragment of the window's first URL, then wiped (`run`).
    ui_boot_code: String,
    /// `sha256_hex(ui_boot_code)`, given to the back as `LOCAL_UI_BOOT_ANCHOR`.
    ui_boot_anchor: String,
    /// The key the back proves it holds (`LOCAL_UI_SHELL_KEY`) before the window, and the code, go to its port.
    shell_key: String,
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
    // One token per link (`linkTokens`): the runner never holds the voice engine's token, nor the reverse.
    let tokens = LaunchTokens { shared: random_token_hex(), links: link_tokens(&cfg.link_names(env::consts::OS), &random_token_hex) };
    let (ui_boot_code, ui_boot_anchor) = ui_boot_code();
    Ok(Context { resources, data_dir, logs_dir, ports, secrets, tokens, ui_boot_code, ui_boot_anchor, shell_key: random_token_hex() })
}

/// The processes to run on this OS, sidecars first, the server last.
fn all_processes(cfg: &DesktopConfig) -> Vec<&ProcessConfig> {
    processes_for(cfg, env::consts::OS)
}

fn processes_for<'a>(cfg: &'a DesktopConfig, os: &str) -> Vec<&'a ProcessConfig> {
    cfg.sidecars.iter().filter(|p| p.runs_on(os)).chain(std::iter::once(&cfg.server)).collect()
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
    let env = process_env(p, &ph, &ctx.tokens, extra.as_ref().map(|core| (&ctx.secrets, core)));
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
        schema: cfg.schema.as_deref(),
        parent_pid: std::process::id(),
        ui_boot_anchor: &ctx.ui_boot_anchor,
        shell_key: &ctx.shell_key,
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
        match start_process(app, cfg, p, ctx) {
            Ok(true) => {}
            Ok(false) => return Ok(false),
            // An optional sidecar that cannot start (missing prerequisite, crash, never ready) must not stop the app.
            Err(_) if p.optional => {
                shell_log(&ctx.logs_dir, &format!("optional process {} did not start: the app goes on without it (see {}.log)", p.name(), p.name()));
                forget_process(app, p.name());
            }
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// Stops tracking a process (an optional one that failed): it is no longer watched.
fn forget_process(app: &AppHandle, name: &str) {
    let state = app.state::<Processes>();
    let mut list = state.0.lock().unwrap();
    if let Some(pos) = list.iter().position(|m| m.name == name) {
        let mut managed = list.remove(pos);
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }
}

/// Names of the optional processes of this run: their death is logged, never shown to the user.
fn optional_names(cfg: &DesktopConfig) -> HashSet<String> {
    all_processes(cfg).into_iter().filter(|p| p.optional).map(|p| p.name().to_string()).collect()
}

fn current_window_url(app: &AppHandle) -> Option<String> {
    app.get_webview_window("main").and_then(|w| w.url().ok()).map(|u| u.to_string())
}

/// If a process dies mid-session, go back to the waiting page with its log. Returns when the app shuts down.
fn watch(app: &AppHandle, cfg: &DesktopConfig, ctx: &Context, splash_url: Option<String>) {
    let optional = optional_names(cfg);
    let mut reported: HashSet<String> = HashSet::new();
    loop {
        thread::sleep(Duration::from_secs(1));
        let dead = {
            let state = app.state::<Processes>();
            let mut list = state.0.lock().unwrap();
            if list.is_empty() {
                return;
            }
            let mut found = None;
            for m in list.iter_mut() {
                let Some(status) = m.child.try_wait().ok().flatten() else { continue };
                if optional.contains(&m.name) {
                    if reported.insert(m.name.clone()) {
                        shell_log(&ctx.logs_dir, &format!("optional process {} exited ({status}): the app goes on without it", m.name));
                    }
                    continue;
                }
                found = Some((m.name.clone(), m.label.clone(), status));
                break;
            }
            found
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

/// The sidecars a page may talk to (`messages` in the config): their port, the token the shell adds (`LaunchTokens::relay_token`), the
/// allowed requests.
fn publish_endpoints(app: &AppHandle, cfg: &DesktopConfig, ctx: &Context) {
    let endpoints = app.state::<SidecarEndpoints>();
    let mut table = endpoints.0.lock().unwrap();
    for p in all_processes(cfg).into_iter().filter(|p| !p.messages.is_empty()) {
        let Some(port) = ctx.ports.get(p.name()) else { continue };
        let token = ctx.tokens.relay_token(p);
        table.insert(p.name().to_string(), Endpoint { port: *port, token, allowed: p.messages.clone() });
    }
}

/// The remote URLs `sidecar_message` is granted to: the page of THIS launch's back, on the numeric loopback it listens on, nothing else
/// (another port, `localhost` / `[::1]` where another process may listen, a frame of an agent's dev server).
pub fn back_capability_urls(port: u16) -> Vec<String> {
    vec![format!("{}/*", back_origin(port))]
}

/// Grants `sidecar_message` to the back's page, once the back proved itself. Added at run time because the port is chosen at each launch.
fn allow_back_origin(app: &AppHandle, port: u16) -> Result<(), BootError> {
    let mut capability = tauri::ipc::CapabilityBuilder::new("sidecar-message-local").window("main").permission("allow-sidecar-message");
    for url in back_capability_urls(port) {
        capability = capability.remote(url);
    }
    app.add_capability(capability).map_err(|e| BootError::new("spawnFailed", vec![param("name", "shell"), param("detail", e)]))
}

/// How the process answering on the back's port replied to the shell's challenge.
#[derive(Debug, PartialEq, Eq)]
pub enum BackProof {
    /// It holds `LOCAL_UI_SHELL_KEY`: it is the back the shell started.
    Proven,
    /// `404`: a back built before the challenge existed. The window goes there WITHOUT the boot code nor `sidecar_message`.
    Legacy,
    /// Anything else (wrong proof, no answer, garbage): the window never goes there.
    Refused,
}

/// Judges a reply to `GET /api/v1/local-ui/shell-proof?nonce=<nonce>`.
pub fn judge_proof(reply: Result<crate::sidecar_message::SidecarReply, String>, shell_key: &str, nonce: &str) -> BackProof {
    match reply {
        Ok(r) if r.status == 404 => BackProof::Legacy,
        Ok(r) if r.status == 200 && r.body["proof"].as_str().is_some_and(|p| constant_time_eq(p, &shell_proof(shell_key, nonce))) => BackProof::Proven,
        _ => BackProof::Refused,
    }
}

/// Is the process answering on the back's port the back this shell started (alive, and holding the per-launch key)? A free port is chosen
/// then released before the back binds it: a local process may take it first, or answer the health check; it never gets the boot code.
fn prove_back(app: &AppHandle, ctx: &Context) -> Result<BackProof, BootError> {
    let refused = |detail: &str| BootError::new("notProven", vec![param("detail", detail)]);
    if !matches!(liveness(app, SERVER_NAME), Liveness::Running) {
        return Err(refused("the back is not running"));
    }
    let nonce = random_token_hex();
    let proof = judge_proof(http_get(ctx.ports[SERVER_NAME], &format!("/api/v1/local-ui/shell-proof?nonce={nonce}")), &ctx.shell_key, &nonce);
    // Checked again after the answer: the back the shell started still holds the port.
    if proof == BackProof::Refused || !matches!(liveness(app, SERVER_NAME), Liveness::Running) {
        return Err(refused("the process answering on the back's port did not prove it is the back this app started"));
    }
    Ok(proof)
}

fn run(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), BootError> {
    let mut ctx = prepare(app, cfg)?;
    publish_endpoints(app, cfg, &ctx);
    shell_log(&ctx.logs_dir, &format!("resources: {}", ctx.resources.display()));
    if !start_all(app, cfg, &ctx)? {
        return Ok(());
    }
    let splash_url = current_window_url(app);
    let port = ctx.ports[SERVER_NAME];
    let proof = prove_back(app, &ctx)?;
    set_back_origin(port);
    // The boot code travels in the fragment of this one navigation (never logged, never sent to the back by the browser); the page exchanges
    // it for its interface session and removes it from the address. The shell keeps no copy.
    let code = std::mem::take(&mut ctx.ui_boot_code);
    let url = if proof == BackProof::Proven {
        allow_back_origin(app, port)?;
        window_url(port, &code)
    } else {
        shell_log(&ctx.logs_dir, "the back does not answer the shell's challenge (built before it): window opened without the interface session nor sidecar_message");
        format!("{}/", back_origin(port))
    };
    eval(app, format!("window.location.replace({})", crate::splash::js_str(&url)));
    drop(code);
    watch(app, cfg, &ctx, splash_url);
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
