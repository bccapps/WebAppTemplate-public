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
    /// Name(s) of the env var(s) that receive the per-launch shared token (same value for every process asking). A list lets
    /// two processes that name the variable differently share one token (e.g. `LOCAL_RUNNER_TOKEN` on the back, `RUNNER_TOKEN` on a runner).
    #[serde(default)]
    pub shared_token: Option<TokenVars>,
    /// Sidecars only: a failure of this process (cannot start, exits, never becomes ready, dies later) is logged in `shell.log`
    /// and ignored: the app starts without it. For auxiliary processes whose prerequisites may be missing on a machine.
    #[serde(default)]
    pub optional: bool,
    /// Sidecars only: operating systems this process runs on (`macos`, `linux`, `windows`); empty = all.
    #[serde(default)]
    pub os: Vec<String>,
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
    if p.command.candidates().iter().all(|c| c.trim().is_empty()) {
        return Err(format!("{name}: command must not be empty"));
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
    fn hex_colors() {
        assert_eq!(parse_hex_color("#0d0b0a"), Some((13, 11, 10)));
        assert_eq!(parse_hex_color("0d0b0a"), None);
        assert_eq!(parse_hex_color("#12345"), None);
        assert_eq!(parse_hex_color("#zzzzzz"), None);
    }
}
