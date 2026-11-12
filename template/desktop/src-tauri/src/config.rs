// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Shell configuration (`desktop.config.json`): parsing and validation. Pure, no I/O.

use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;

pub const DEFAULT_HEALTH_PATH: &str = "/api/v1/health";
pub const SERVER_NAME: &str = "server";
/// Values of `schema` (the back's `DB_SCHEMA_MODE`).
pub const SCHEMA_MODES: [&str; 3] = ["sync", "migrations", "manual"];

/// One command, or an ordered list of candidates (first usable wins: absolute paths must exist, bare names
/// are looked up in `PATH`). Lets one config serve both the packaged app and `desktop:dev`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CommandSpec {
    One(String),
    Many(Vec<String>),
}

impl CommandSpec {
    pub fn candidates(&self) -> Vec<String> {
        match self {
            CommandSpec::One(c) => vec![c.clone()],
            CommandSpec::Many(list) => list.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessConfig {
    /// Required for sidecars; the server is always named `server`.
    #[serde(default)]
    pub name: Option<String>,
    /// Display name in splash messages (defaults to `name`).
    #[serde(default)]
    pub label: Option<String>,
    pub command: CommandSpec,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Sidecars only: allocate a free loopback port, exposed as `{port}` / `{port:<name>}`.
    #[serde(default)]
    pub port: bool,
    /// HTTP path polled until it answers 200. Server default: `/api/v1/health`. Sidecars: none (no wait).
    #[serde(default)]
    pub health_path: Option<String>,
    #[serde(default = "default_ready_timeout")]
    pub ready_timeout_sec: u64,
    /// Legacy: name(s) of the env var(s) that receive the ONE per-launch token shared by every process that declares `sharedToken`.
    /// Prefer `linkTokens` (one token per link): with `sharedToken`, a process holding the token of one link holds every other's.
    #[serde(default)]
    pub shared_token: Option<TokenVars>,
    /// Per-link tokens, `{ "ENV_VAR": "<link>" }`: every link gets its own random token at each launch, the same for every process that
    /// names it (the back's `LOCAL_RUNNER_TOKEN` and a runner's `RUNNER_TOKEN` both naming `runner`). The link named after a sidecar is also
    /// the token the shell adds when it relays a `sidecar_message` to that sidecar.
    #[serde(default)]
    pub link_tokens: BTreeMap<String, String>,
    /// Sidecars only: a failure of this process (cannot start, exits, never becomes ready, dies later) is logged in `shell.log`
    /// and ignored: the app starts without it. For auxiliary processes whose prerequisites may be missing on a machine.
    #[serde(default)]
    pub optional: bool,
    /// Sidecars only: operating systems this process runs on (`macos`, `linux`, `windows`); empty = all.
    #[serde(default)]
    pub os: Vec<String>,
    /// Sidecars only: the requests the webview may relay to this sidecar through the `sidecar_message` command, as exact `"METHOD /path"`
    /// entries (`"POST /v1/pair"`). Empty = the sidecar cannot be reached from a page. Needs `port`.
    #[serde(default)]
    pub messages: Vec<String>,
}

/// Who may call `sidecar_message` besides the page of the local back (always allowed).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagingConfig {
    /// Origins (`https://hub.example.com`, no path) whose pages may call the command: the remote hub a window shows in client mode.
    #[serde(default)]
    pub origins: Vec<String>,
}

/// One env var name, or several receiving the same token.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum TokenVars {
    One(String),
    Many(Vec<String>),
}

impl TokenVars {
    pub fn names(&self) -> Vec<&str> {
        match self {
            TokenVars::One(v) => vec![v.as_str()],
            TokenVars::Many(list) => list.iter().map(String::as_str).collect(),
        }
    }
}

pub const KNOWN_OS: [&str; 3] = ["macos", "linux", "windows"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowConfig {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    #[serde(default = "default_min_width")]
    pub min_width: f64,
    #[serde(default = "default_min_height")]
    pub min_height: f64,
    /// `dark`, `light` or `system`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Pages of the app's own interface (`/agents/*`) a new-window request (« open in a window ») shows in the main window
    /// (`navigation.rs` `path_matches`); any other page of the back asked that way is refused, unless `browser_paths` lists it.
    #[serde(default)]
    pub same_window_paths: Vec<String>,
    /// Pages of the back a new-window request opens in the system browser (content served for someone else, such as an agent's preview).
    #[serde(default)]
    pub browser_paths: Vec<String>,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            title: None,
            width: default_width(),
            height: default_height(),
            min_width: default_min_width(),
            min_height: default_min_height(),
            theme: default_theme(),
            same_window_paths: Vec::new(),
            browser_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcesConfig {
    /// File (relative to the resources folder) that identifies it.
    #[serde(default = "default_marker")]
    pub marker: String,
    /// Built front, relative to the resources folder (`SERVE_FRONT_DIR`).
    #[serde(default = "default_front_dir")]
    pub front_dir: String,
}

impl Default for ResourcesConfig {
    fn default() -> Self {
        Self { marker: default_marker(), front_dir: default_front_dir() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandConfig {
    #[serde(default = "default_background")]
    pub background: String,
    #[serde(default = "default_foreground")]
    pub foreground: String,
    #[serde(default = "default_accent")]
    pub accent: String,
}

impl Default for BrandConfig {
    fn default() -> Self {
        Self { background: default_background(), foreground: default_foreground(), accent: default_accent() }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplashConfig {
    #[serde(default)]
    pub brand: BrandConfig,
    /// Per-language overrides of the default messages (`splash/messages.json`).
    #[serde(default)]
    pub texts: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopConfig {
    pub product_name: String,
    pub identifier: String,
    #[serde(default)]
    pub window: WindowConfig,
    #[serde(default)]
    pub resources: ResourcesConfig,
    #[serde(default = "default_db_file")]
    pub db_file: String,
    /// How the database schema is managed at boot, forced on the back as `DB_SCHEMA_MODE`: `sync` (synchronize, no migrations),
    /// `migrations` (the app's own migrations run at start) or `manual`. Absent = the legacy behaviour: the shell forces
    /// `DB_MIGRATIONS_RUN=true` (the app has hand-written SQLite migrations).
    #[serde(default)]
    pub schema: Option<String>,
    pub server: ProcessConfig,
    #[serde(default)]
    pub sidecars: Vec<ProcessConfig>,
    #[serde(default)]
    pub splash: SplashConfig,
    #[serde(default)]
    pub messaging: MessagingConfig,
    /// Read by the packaging scripts (`scripts/desktop/`) only; the shell ignores it.
    #[serde(default)]
    #[allow(dead_code)]
    pub packaging: Option<serde_json::Value>,
}

fn default_ready_timeout() -> u64 {
    120
}
fn default_width() -> f64 {
    1280.0
}
fn default_height() -> f64 {
    800.0
}
fn default_min_width() -> f64 {
    900.0
}
fn default_min_height() -> f64 {
    600.0
}
fn default_theme() -> String {
    "dark".into()
}
fn default_marker() -> String {
    "back/dist/main.js".into()
}
fn default_front_dir() -> String {
    "front/dist".into()
}
fn default_db_file() -> String {
    "app.db".into()
}
fn default_background() -> String {
    "#0d0b0a".into()
}
fn default_foreground() -> String {
    "#efe8e1".into()
}
fn default_accent() -> String {
    "#ff5b37".into()
}

impl ProcessConfig {
    pub fn name(&self) -> &str {
        self.name.as_deref().unwrap_or(SERVER_NAME)
    }

    pub fn label(&self) -> &str {
        self.label.as_deref().unwrap_or_else(|| self.name())
    }

    /// Whether this process runs on `os` (`std::env::consts::OS`); no `os` list = everywhere.
    pub fn runs_on(&self, os: &str) -> bool {
        self.os.is_empty() || self.os.iter().any(|o| o == os)
    }
}

/// Parses and validates the JSON text of `desktop.config.json`.
pub fn parse_config(text: &str) -> Result<DesktopConfig, String> {
    let mut cfg: DesktopConfig = serde_json::from_str(text).map_err(|e| format!("desktop.config.json: {e}"))?;
    cfg.server.name = Some(SERVER_NAME.into());
    cfg.server.port = true;
    cfg.server.health_path.get_or_insert_with(|| DEFAULT_HEALTH_PATH.into());
    validate(&cfg)?;
    Ok(cfg)
}

fn validate(cfg: &DesktopConfig) -> Result<(), String> {
    if cfg.product_name.trim().is_empty() {
        return Err("productName must not be empty".into());
    }
    if cfg.identifier.trim().is_empty() {
        return Err("identifier must not be empty".into());
    }
    if let Some(schema) = &cfg.schema {
        if !SCHEMA_MODES.contains(&schema.as_str()) {
            return Err(format!("schema must be one of {} (got \"{schema}\")", SCHEMA_MODES.join(", ")));
        }
    }
    for origin in &cfg.messaging.origins {
        valid_origin(origin)?;
    }
    for pattern in &cfg.window.same_window_paths {
        valid_path_pattern("window.sameWindowPaths", pattern, false)?;
    }
    for pattern in &cfg.window.browser_paths {
        valid_path_pattern("window.browserPaths", pattern, true)?;
    }
    validate_process(&cfg.server)?;
    let mut seen: HashSet<&str> = HashSet::from([SERVER_NAME]);
    for sidecar in &cfg.sidecars {
        let name = sidecar.name.as_deref().ok_or("every sidecar needs a name")?;
        if !seen.insert(name) {
            return Err(format!("duplicate or reserved process name: {name}"));
        }
        validate_process(sidecar)?;
    }
    Ok(())
}

fn validate_process(p: &ProcessConfig) -> Result<(), String> {
    let name = p.name();
    if p.name.as_deref() == Some(SERVER_NAME) && (p.optional || !p.os.is_empty()) {
        return Err("the server cannot be optional or restricted to some operating systems".into());
    }
    if let Some(bad) = p.os.iter().find(|o| !KNOWN_OS.contains(&o.as_str())) {
        return Err(format!("{name}: unknown os \"{bad}\" (expected: {})", KNOWN_OS.join(", ")));
    }
    if let Some(vars) = &p.shared_token {
        if vars.names().iter().any(|v| v.trim().is_empty()) {
            return Err(format!("{name}: sharedToken names must not be empty"));
        }
    }
    for (var, link) in &p.link_tokens {
        if var.trim().is_empty() || var.contains('=') {
            return Err(format!("{name}: linkTokens variable names must not be empty nor contain '='"));
        }
        if !valid_link_name(link) {
            return Err(format!("{name}: linkTokens link \"{link}\" must be lowercase letters, digits and '-'"));
        }
        if p.shared_token.as_ref().is_some_and(|vars| vars.names().contains(&var.as_str())) {
            return Err(format!("{name}: {var} is both in sharedToken and in linkTokens"));
        }
    }
    if p.command.candidates().iter().all(|c| c.trim().is_empty()) {
        return Err(format!("{name}: command must not be empty"));
    }
    if !p.messages.is_empty() {
        if p.name.as_deref() == Some(SERVER_NAME) {
            return Err("the server has no messages: only sidecars can be reached by sidecar_message".into());
        }
        if !p.port {
            return Err(format!("{name}: messages require \"port\": true"));
        }
        for entry in &p.messages {
            crate::sidecar_message::valid_message_entry(entry).map_err(|e| format!("{name}: messages {e}"))?;
        }
    }
    if let Some(path) = &p.health_path {
        if !path.starts_with('/') {
            return Err(format!("{name}: healthPath must start with '/'"));
        }
        if !p.port {
            return Err(format!("{name}: healthPath requires \"port\": true"));
        }
    }
    Ok(())
}

/// A `linkTokens` link name: `[a-z0-9-]+`.
fn valid_link_name(link: &str) -> bool {
    !link.is_empty() && link.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl DesktopConfig {
    /// Every link named in a `linkTokens` of the processes that run on `os`, once each.
    pub fn link_names(&self, os: &str) -> Vec<String> {
        let mut names: Vec<String> = self
            .sidecars
            .iter()
            .filter(|p| p.runs_on(os))
            .chain(std::iter::once(&self.server))
            .flat_map(|p| p.link_tokens.values().cloned())
            .collect();
        names.sort();
        names.dedup();
        names
    }
}

/// `https://host[:port]`, nothing after it (the loopback `http` origins are the local back's, already allowed).
fn valid_origin(origin: &str) -> Result<(), String> {
    let rest = origin.strip_prefix("https://").ok_or_else(|| format!("messaging.origins: \"{origin}\" must start with https://"))?;
    if rest.is_empty() || rest.contains('/') || rest.contains('*') || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("messaging.origins: \"{origin}\" must be a bare origin (https://host[:port])"));
    }
    Ok(())
}

/// A path pattern of `window` (`navigation.rs` `path_matches`): `/`-separated literal or `*` segments, `**` only last and only where `rest`
/// allows it (never for the main window). It starts with a literal segment other than `api` — the back's API never opens in the main window —,
/// except in `browserPaths` (`rest`), where a page the back serves under its API for someone else (an agent's preview,
/// `/api/v1/<module>/previews/*/*/**`) may go to the system browser: such a pattern names at least four literal segments, then a `*` (in any
/// case of `api`: the back's routes ignore it).
fn valid_path_pattern(field: &str, pattern: &str, rest: bool) -> Result<(), String> {
    let invalid = || format!("{field}: \"{pattern}\" must be /literal[/literal|*]{}", if rest { "[/**] (under /api: four literal segments, then *)" } else { " (never /api)" });
    let segments: Vec<&str> = pattern.strip_prefix('/').ok_or_else(invalid)?.split('/').collect();
    if !crate::navigation::is_plain_segment(segments[0]) {
        return Err(invalid());
    }
    // Any case: the back's routes are matched case-insensitively (`/API/…` is its API too).
    if segments[0].eq_ignore_ascii_case("api") {
        // Under /api (browserPaths only): four literal segments, then a `*` — a page with an id of its own (a preview), never a whole route
        // (`/api/v1/auth/logout/**`).
        let literal = segments.iter().take_while(|segment| crate::navigation::is_plain_segment(segment)).count();
        if !rest || literal < 4 || segments.get(literal) != Some(&"*") {
            return Err(invalid());
        }
    }
    for (index, segment) in segments.iter().enumerate().skip(1) {
        let last_rest = rest && *segment == "**" && index == segments.len() - 1;
        if !(last_rest || *segment == "*" || crate::navigation::is_plain_segment(segment)) {
            return Err(invalid());
        }
    }
    Ok(())
}

/// `#rrggbb` to its components.
pub fn parse_hex_color(s: &str) -> Option<(u8, u8, u8)> {
    let hex = s.strip_prefix('#')?;
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let part = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some((part(0)?, part(2)?, part(4)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{"productName":"A","identifier":"x.y","server":{"command":"node"}}"#;

    #[test]
    fn minimal_config_gets_defaults() {
        let cfg = parse_config(MINIMAL).unwrap();
        assert_eq!(cfg.server.name(), "server");
        assert_eq!(cfg.server.health_path.as_deref(), Some(DEFAULT_HEALTH_PATH));
        assert!(cfg.server.port);
        assert_eq!(cfg.server.ready_timeout_sec, 120);
        assert_eq!(cfg.resources.front_dir, "front/dist");
        assert_eq!(cfg.window.theme, "dark");
    }

    #[test]
    fn command_accepts_string_or_list() {
        let cfg = parse_config(r#"{"productName":"A","identifier":"x","server":{"command":["a","b"]}}"#).unwrap();
        assert_eq!(cfg.server.command.candidates(), vec!["a", "b"]);
    }

    #[test]
    fn sidecar_rules_are_enforced() {
        let with = |s: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"}},"sidecars":[{s}]}}"#);
        assert!(parse_config(&with(r#"{"command":"p"}"#)).unwrap_err().contains("needs a name"));
        assert!(parse_config(&with(r#"{"name":"server","command":"p"}"#)).unwrap_err().contains("reserved"));
        assert!(parse_config(&with(r#"{"name":"e","command":"p","healthPath":"/h"}"#)).unwrap_err().contains("requires"));
        assert!(parse_config(&with(r#"{"name":"e","command":"p","port":true,"healthPath":"h"}"#)).unwrap_err().contains("start with"));
        let ok = parse_config(&with(r#"{"name":"e","command":"p","port":true,"healthPath":"/h"}"#)).unwrap();
        assert_eq!(ok.sidecars[0].label(), "e");
    }

    #[test]
    fn sidecar_optional_os_and_token_lists() {
        let with = |s: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"}},"sidecars":[{s}]}}"#);
        let ok = parse_config(&with(r#"{"name":"r","command":"p","optional":true,"os":["macos","linux"],"sharedToken":["A","B"]}"#)).unwrap();
        let r = &ok.sidecars[0];
        assert!(r.optional && r.runs_on("macos") && r.runs_on("linux") && !r.runs_on("windows"));
        assert_eq!(r.shared_token.as_ref().unwrap().names(), vec!["A", "B"]);
        let single = parse_config(&with(r#"{"name":"r","command":"p","sharedToken":"ONLY"}"#)).unwrap();
        assert_eq!(single.sidecars[0].shared_token.as_ref().unwrap().names(), vec!["ONLY"]);
        assert!(single.sidecars[0].runs_on("windows"), "no os list = everywhere");
        assert!(parse_config(&with(r#"{"name":"r","command":"p","os":["beos"]}"#)).unwrap_err().contains("unknown os"));
        assert!(parse_config(&with(r#"{"name":"r","command":"p","sharedToken":[" "]}"#)).unwrap_err().contains("must not be empty"));
        assert!(parse_config(r#"{"productName":"A","identifier":"x","server":{"command":"n","optional":true}}"#).unwrap_err().contains("server cannot"));
    }

    #[test]
    fn link_tokens_are_validated_and_listed_per_os() {
        let with = |s: &str, server: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"{server}}},"sidecars":[{s}]}}"#);
        let ok = parse_config(&with(
            r#"{"name":"r","command":"p","os":["macos"],"linkTokens":{"RUNNER_TOKEN":"runner"}},{"name":"e","command":"p","linkTokens":{"ENGINE_TOKEN":"engine"}}"#,
            r#","linkTokens":{"LOCAL_RUNNER_TOKEN":"runner","ENGINE_TOKEN":"engine"}"#,
        ))
        .unwrap();
        assert_eq!(ok.server.link_tokens["LOCAL_RUNNER_TOKEN"], "runner");
        assert_eq!(ok.link_names("macos"), vec!["engine", "runner"]);
        assert_eq!(ok.link_names("windows"), vec!["engine", "runner"], "the server names both links on every OS");
        for bad in [r#"{"":"runner"}"#, r#"{"A=B":"runner"}"#, r#"{"T":""}"#, r#"{"T":"Runner"}"#, r#"{"T":"a b"}"#] {
            assert!(parse_config(&with(&format!(r#"{{"name":"r","command":"p","linkTokens":{bad}}}"#), "")).is_err(), "{bad}");
        }
        let both = with(r#"{"name":"r","command":"p","sharedToken":"T","linkTokens":{"T":"runner"}}"#, "");
        assert!(parse_config(&both).unwrap_err().contains("both in sharedToken and in linkTokens"));
    }

    #[test]
    fn rejects_unknown_fields_and_empty_names() {
        assert!(parse_config(r#"{"productName":"A","identifier":"x","server":{"command":"n"},"oops":1}"#).is_err());
        assert!(parse_config(r#"{"productName":" ","identifier":"x","server":{"command":"n"}}"#).is_err());
    }

    #[test]
    fn schema_is_optional_and_validated() {
        let with = |s: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"}}{s}}}"#);
        assert_eq!(parse_config(&with("")).unwrap().schema, None);
        for mode in SCHEMA_MODES {
            assert_eq!(parse_config(&with(&format!(r#","schema":"{mode}""#))).unwrap().schema.as_deref(), Some(mode));
        }
        assert!(parse_config(&with(r#","schema":"auto""#)).unwrap_err().contains("sync, migrations, manual"));
    }

    #[test]
    fn window_paths_are_validated() {
        let with = |w: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"}},"window":{{{w}}}}}"#);
        let ok = parse_config(&with(r#""sameWindowPaths":["/agents/*","/settings/access"],"browserPaths":["/api/v1/agenthub/previews/*/*/**"]"#)).unwrap();
        assert_eq!(ok.window.same_window_paths, vec!["/agents/*", "/settings/access"]);
        assert_eq!(ok.window.browser_paths, vec!["/api/v1/agenthub/previews/*/*/**"]);
        assert!(parse_config(&with("")).unwrap().window.same_window_paths.is_empty());
        for bad in ["/agents/**", "agents/*", "/*/x", "/api/v1/x", "/API/v1/x", "/Api/v1/x", "/api/v1/agenthub/previews/*", "/agents/", "/agents/../api", "/agents/%2e", "/", "/a//b"] {
            assert!(parse_config(&with(&format!(r#""sameWindowPaths":["{bad}"]"#))).is_err(), "{bad}");
        }
        // Under /api, only a precise page of the back goes to the browser: four literal segments before any wildcard.
        for bad in ["/previews/**/x", "/api/**", "/API/**", "/Api/v1/x/**", "/api/v1/**", "/api/v1/*/previews/**", "/api/v1/agenthub/**", "/api/v1/auth/logout/**", "/API/v1/auth/logout/**", "/api/v1/agenthub/previews/**", "/**", "previews/**"] {
            assert!(parse_config(&with(&format!(r#""browserPaths":["{bad}"]"#))).is_err(), "{bad}");
        }
    }

    #[test]
    fn messages_and_origins_are_validated() {
        let with = |s: &str, m: &str| format!(r#"{{"productName":"A","identifier":"x","server":{{"command":"n"}}{m},"sidecars":[{s}]}}"#);
        let ok = parse_config(&with(r#"{"name":"e","command":"p","port":true,"messages":["POST /v1/pair","GET /v1/status"]}"#, r#","messaging":{"origins":["https://hub.example.com"]}"#)).unwrap();
        assert_eq!(ok.sidecars[0].messages.len(), 2);
        assert_eq!(ok.messaging.origins, vec!["https://hub.example.com"]);
        assert!(parse_config(&with(r#"{"name":"e","command":"p","messages":["POST /v1/pair"]}"#, "")).unwrap_err().contains("require"));
        assert!(parse_config(&with(r#"{"name":"e","command":"p","port":true,"messages":["PATCH /x"]}"#, "")).unwrap_err().contains("method must be"));
        assert!(parse_config(&with(r#"{"name":"e","command":"p","port":true,"messages":["GET /a/../b"]}"#, "")).is_err());
        assert!(parse_config(r#"{"productName":"A","identifier":"x","server":{"command":"n","messages":["GET /x"]}}"#).unwrap_err().contains("server has no messages"));
        for bad in ["http://hub.example.com", "https://*.example.com", "https://hub.example.com/path", "hub.example.com", "https://"] {
            assert!(parse_config(&with(r#"{"name":"e","command":"p"}"#, &format!(r#","messaging":{{"origins":["{bad}"]}}"#))).is_err(), "{bad}");
        }
    }

    #[test]
    fn hex_colors() {
        assert_eq!(parse_hex_color("#0d0b0a"), Some((13, 11, 10)));
        assert_eq!(parse_hex_color("0d0b0a"), None);
        assert_eq!(parse_hex_color("#12345"), None);
        assert_eq!(parse_hex_color("#zzzzzz"), None);
    }
}
