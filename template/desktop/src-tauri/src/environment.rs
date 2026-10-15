// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Environment of the managed processes: placeholders, secrets, shared token and the variables the shell
//! injects into the back at every launch. Pure except for the secrets file helpers.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::ProcessConfig;

/// Secrets generated on first launch, under the same names as the env vars of the project's `back/.env`.
pub const SECRET_KEYS: [&str; 2] = ["CRYPT_DB_MASTER_KEY", "CRYPT_SESSION_PRIVATE_KEY"];

/// Values available to `{placeholders}` in a process's command, args, cwd and env.
pub struct Placeholders {
    pub resources: PathBuf,
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub own_port: Option<u16>,
    pub ports: BTreeMap<String, u16>,
}

/// Replaces `{resources}`, `{dataDir}`, `{logsDir}`, `{port}` and `{port:<name>}`; any other brace text is kept.
pub fn substitute(template: &str, ph: &Placeholders) -> String {
    let mut out = template
        .replace("{resources}", &ph.resources.to_string_lossy())
        .replace("{dataDir}", &ph.data_dir.to_string_lossy())
        .replace("{logsDir}", &ph.logs_dir.to_string_lossy());
    for (name, port) in &ph.ports {
        out = out.replace(&format!("{{port:{name}}}"), &port.to_string());
    }
    match ph.own_port {
        Some(p) => out.replace("{port}", &p.to_string()),
        None => out,
    }
}

/// Standard base64 with padding.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 random bytes from the OS, as base64 (same shape as `randomKeyB64` in `create-project.mjs`).
pub fn random_key_b64() -> String {
    base64_encode(&random_bytes())
}

/// Per-launch token shared by the processes that ask for it.
pub fn random_token_hex() -> String {
    hex_encode(&random_bytes())
}

fn random_bytes() -> [u8; 32] {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("the OS random generator is unavailable");
    buf
}

/// Loads `secrets.json`, generating (and persisting with mode 0600 on Unix) any missing secret.
pub fn ensure_secrets(path: &Path, generate: &dyn Fn() -> String) -> Result<BTreeMap<String, String>, String> {
    let mut secrets: BTreeMap<String, String> = match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
        Err(_) => BTreeMap::new(),
    };
    let mut changed = false;
    for key in SECRET_KEYS {
        if secrets.get(key).map_or(true, |v| v.is_empty()) {
            secrets.insert(key.into(), generate());
            changed = true;
        }
    }
    if changed {
        write_private(path, &serde_json::to_string_pretty(&secrets).map_err(|e| e.to_string())?)?;
    }
    Ok(secrets)
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Facts the shell knows about the back it starts.
pub struct ServerFacts<'a> {
    pub port: u16,
    pub data_dir: &'a Path,
    pub logs_dir: &'a Path,
    pub front_dir: PathBuf,
    pub db_file: &'a str,
    /// `desktop.config.json` `schema`: forced as `DB_SCHEMA_MODE`. `None` = legacy, `DB_MIGRATIONS_RUN=true` is forced instead.
    pub schema: Option<&'a str>,
    pub parent_pid: u32,
}

/// Variables injected into the back at every launch. They always win over the config's own `env`.
pub fn server_core_env(f: &ServerFacts) -> BTreeMap<String, String> {
    let origin = format!("http://127.0.0.1:{}", f.port);
    let p = |path: &Path| path.to_string_lossy().into_owned();
    let mut vars: Vec<(&str, String)> = vec![
        ("HOST", "127.0.0.1".to_string()),
        ("NODE_PORT", f.port.to_string()),
        ("CLIENT_ORIGINS", format!("{origin},http://localhost:{}", f.port)),
        ("LOCAL_TRUST", "true".into()),
        // Forced, so no inherited `DB_ENGINE=postgres` (a developer's shell) can switch the packaged app to another database.
        ("DB_ENGINE", "sqlite".into()),
        ("DB_PATH", p(&f.data_dir.join(f.db_file))),
        ("APP_DATA_DIR", p(f.data_dir)),
        ("LOG_DIR", p(f.logs_dir)),
        ("SHARED_DIRECTORY", p(&f.data_dir.join("shared"))),
        ("DISABLE_TRANSPORT_CRYPTO", "true".into()),
        ("APP_ENV", "desktop".into()),
        ("SERVE_FRONT_DIR", p(&f.front_dir)),
        ("DESKTOP_PARENT_PID", f.parent_pid.to_string()),
    ];
    // Schema management of the back (`nest/database/schemaMode.ts`): an app that declares `schema` gets exactly that mode; an app
    // that does not keeps the historical forcing of `DB_MIGRATIONS_RUN=true` (SQLite apps with their own migrations).
    match f.schema {
        Some(mode) => vars.push(("DB_SCHEMA_MODE", mode.to_string())),
        None => vars.push(("DB_MIGRATIONS_RUN", "true".into())),
    }
    vars.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// Final environment of one process: config `env` (placeholders resolved), the shared token, and for the
/// server the secrets then the injected variables.
pub fn process_env(
    cfg: &ProcessConfig,
    ph: &Placeholders,
    token: &str,
    server_extra: Option<(&BTreeMap<String, String>, &BTreeMap<String, String>)>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = cfg.env.iter().map(|(k, v)| (k.clone(), substitute(v, ph))).collect();
    if let Some(vars) = &cfg.shared_token {
        for var in vars.names() {
            env.insert(var.to_string(), token.to_string());
        }
    }
    if let Some((secrets, core)) = server_extra {
        env.extend(secrets.clone());
        env.extend(core.clone());
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_config;

    fn ph() -> Placeholders {
        Placeholders {
            resources: "/res".into(),
            data_dir: "/data".into(),
            logs_dir: "/data/logs".into(),
            own_port: Some(5000),
            ports: BTreeMap::from([("engine".to_string(), 6000u16)]),
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desktop-shell-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn substitutes_known_placeholders_only() {
        let out = substitute("{resources}/a {dataDir} {logsDir} {port} {port:engine} {other} {\"json\":1}", &ph());
        assert_eq!(out, "/res/a /data /data/logs 5000 6000 {other} {\"json\":1}");
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn random_values_have_the_expected_shape_and_differ() {
        let (a, b) = (random_key_b64(), random_key_b64());
        assert_eq!(a.len(), 44);
        assert_ne!(a, b);
        assert_eq!(random_token_hex().len(), 64);
    }

    #[test]
    fn secrets_are_generated_once_and_kept() {
        let dir = tmp("secrets");
        let path = dir.join("secrets.json");
        let first = ensure_secrets(&path, &|| "gen1".to_string()).unwrap();
        assert_eq!(first["CRYPT_DB_MASTER_KEY"], "gen1");
        let again = ensure_secrets(&path, &|| "gen2".to_string()).unwrap();
        assert_eq!(first, again);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_secret_is_added_without_touching_existing_ones() {
        let dir = tmp("partial");
        let path = dir.join("secrets.json");
        fs::write(&path, r#"{"CRYPT_DB_MASTER_KEY":"keep","EXTRA":"x"}"#).unwrap();
        let s = ensure_secrets(&path, &|| "new".to_string()).unwrap();
        assert_eq!(s["CRYPT_DB_MASTER_KEY"], "keep");
        assert_eq!(s["CRYPT_SESSION_PRIVATE_KEY"], "new");
        assert_eq!(s["EXTRA"], "x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn core_env_has_the_injected_variables() {
        let facts = ServerFacts {
            port: 4321,
            data_dir: Path::new("/d"),
            logs_dir: Path::new("/d/logs"),
            front_dir: PathBuf::from("/r/front/dist"),
            db_file: "app.db",
            schema: None,
            parent_pid: 77,
        };
        let env = server_core_env(&facts);
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["NODE_PORT"], "4321");
        assert_eq!(env["CLIENT_ORIGINS"], "http://127.0.0.1:4321,http://localhost:4321");
        assert_eq!(env["LOCAL_TRUST"], "true");
        assert_eq!(env["DB_ENGINE"], "sqlite");
        assert_eq!(env["DB_PATH"], "/d/app.db");
        assert_eq!(env["DB_MIGRATIONS_RUN"], "true", "legacy: without `schema` the shell forces DB_MIGRATIONS_RUN=true");
        assert!(!env.contains_key("DB_SCHEMA_MODE"));
        assert_eq!(env["SHARED_DIRECTORY"], "/d/shared");
        assert_eq!(env["DISABLE_TRANSPORT_CRYPTO"], "true");
        assert_eq!(env["APP_ENV"], "desktop");
        assert_eq!(env["SERVE_FRONT_DIR"], "/r/front/dist");
        assert_eq!(env["DESKTOP_PARENT_PID"], "77");
        for key in ["APP_DATA_DIR", "LOG_DIR"] {
            assert!(env.contains_key(key));
        }
    }

    #[test]
    fn a_declared_schema_is_forced_as_db_schema_mode_instead_of_db_migrations_run() {
        for mode in ["sync", "migrations", "manual"] {
            let facts = ServerFacts {
                port: 4321,
                data_dir: Path::new("/d"),
                logs_dir: Path::new("/d/logs"),
                front_dir: PathBuf::from("/r/front/dist"),
                db_file: "app.db",
                schema: Some(mode),
                parent_pid: 77,
            };
            let env = server_core_env(&facts);
            assert_eq!(env["DB_SCHEMA_MODE"], mode);
            assert!(!env.contains_key("DB_MIGRATIONS_RUN"), "DB_MIGRATIONS_RUN must not be forced next to DB_SCHEMA_MODE");
        }
    }

    #[test]
    fn injected_variables_win_over_config_and_sidecars_get_only_their_own() {
        let cfg = parse_config(
            r#"{"productName":"A","identifier":"x","server":{"command":"n","env":{"LOCAL_TRUST":"false","K":"{dataDir}"},"sharedToken":"ENGINE_TOKEN"},
                "sidecars":[{"name":"engine","command":"p","port":true,"env":{"PORT":"{port}"},"sharedToken":"TOKEN"}]}"#,
        )
        .unwrap();
        let core = BTreeMap::from([("LOCAL_TRUST".to_string(), "true".to_string())]);
        let secrets = BTreeMap::from([("CRYPT_DB_MASTER_KEY".to_string(), "s".to_string())]);
        let server = process_env(&cfg.server, &ph(), "tok", Some((&secrets, &core)));
        assert_eq!(server["LOCAL_TRUST"], "true");
        assert_eq!(server["K"], "/data");
        assert_eq!(server["ENGINE_TOKEN"], "tok");
        assert_eq!(server["CRYPT_DB_MASTER_KEY"], "s");
        let side = process_env(&cfg.sidecars[0], &ph(), "tok", None);
        assert_eq!(side["PORT"], "5000");
        assert_eq!(side["TOKEN"], "tok");
        assert!(!side.contains_key("CRYPT_DB_MASTER_KEY"));
    }
}
