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

/// A per-launch token (the legacy shared token, each link's token): 32 random bytes in hex.
pub fn random_token_hex() -> String {
    hex_encode(&random_bytes())
}

/// One fresh token per link name (`linkTokens`), all different.
pub fn link_tokens(names: &[String], generate: &dyn Fn() -> String) -> BTreeMap<String, String> {
    names.iter().map(|name| (name.clone(), generate())).collect()
}

/// SHA-256 of `text` (its UTF-8 bytes), lowercase hex.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex_encode(&Sha256::digest(text.as_bytes()))
}

/// The interface boot code of this launch (32 random bytes, hex) and its anchor (`sha256_hex(code)`). The anchor goes to the back
/// (`LOCAL_UI_BOOT_ANCHOR`, not a secret: it only lets the back recognise the code); the code goes ONLY into the fragment of the URL the
/// window opens (`window_url`), never into a process environment, a file or a log.
pub fn ui_boot_code() -> (String, String) {
    let code = random_token_hex();
    let anchor = sha256_hex(&code);
    (code, anchor)
}

/// HMAC-SHA256 (RFC 2104) of `msg` under `key`, lowercase hex.
pub fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    hex_encode(&Sha256::new().chain_update(opad).chain_update(inner).finalize())
}

/// What the back must answer to the shell's challenge `nonce` (`GET /api/v1/local-ui/shell-proof?nonce=`): the HMAC of the nonce under the
/// per-launch shell key (`LOCAL_UI_SHELL_KEY`, given to the back only). The key is the UTF-8 of its hex text (the back does the same).
pub fn shell_proof(shell_key: &str, nonce: &str) -> String {
    hmac_sha256_hex(shell_key.as_bytes(), nonce.as_bytes())
}

/// Equality whose time does not depend on where two strings differ.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Fragment key of the interface boot code (`react/common` `core/http/localUiSession.ts` reads and removes it).
pub const UI_BOOT_FRAGMENT_KEY: &str = "vx-local-ui";

/// The first URL of the window: the back's root, the boot code in the fragment (a fragment is never sent to a server nor logged by it).
pub fn window_url(port: u16, code: &str) -> String {
    format!("http://127.0.0.1:{port}/#{UI_BOOT_FRAGMENT_KEY}={code}")
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
    /// `sha256_hex` of this launch's interface boot code (`ui_boot_code`), forced as `LOCAL_UI_BOOT_ANCHOR`.
    pub ui_boot_anchor: &'a str,
    /// The per-launch key the back proves it holds before the window is sent to it (`LOCAL_UI_SHELL_KEY`, `shell_proof`).
    pub shell_key: &'a str,
}

/// Variables injected into the back at every launch. They always win over the config's own `env`.
pub fn server_core_env(f: &ServerFacts) -> BTreeMap<String, String> {
    let origin = format!("http://127.0.0.1:{}", f.port);
    let p = |path: &Path| path.to_string_lossy().into_owned();
    let mut vars: Vec<(&str, String)> = vec![
        ("HOST", "127.0.0.1".to_string()),
        ("NODE_PORT", f.port.to_string()),
        // The window's origin only: the back listens on 127.0.0.1, `localhost` may resolve to `[::1]`, where another process can listen.
        ("CLIENT_ORIGINS", origin.clone()),
        ("LOCAL_TRUST", "true".into()),
        // Local trust also needs the interface session the window opens with (`nest/common/README.md`, « Session d'interface locale »):
        // a local process without it (an agent, a script) is not the administrator.
        ("LOCAL_UI_BOOT_ANCHOR", f.ui_boot_anchor.to_string()),
        // Before sending the window (and the boot code) to the port, the shell checks that THIS back answers there (`boot.rs` `prove_back`).
        ("LOCAL_UI_SHELL_KEY", f.shell_key.to_string()),
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

/// The tokens of one launch: the legacy shared token (`sharedToken`) and one per link (`linkTokens`).
pub struct LaunchTokens {
    pub shared: String,
    pub links: BTreeMap<String, String>,
}

impl LaunchTokens {
    /// The token the shell adds when it relays a `sidecar_message` to `p`: its link named after it, else the legacy shared token.
    pub fn relay_token(&self, p: &ProcessConfig) -> Option<String> {
        if p.link_tokens.values().any(|link| link == p.name()) {
            return self.links.get(p.name()).cloned();
        }
        p.shared_token.is_some().then(|| self.shared.clone())
    }
}

/// Final environment of one process: config `env` (placeholders resolved), the shared token, the tokens of its links, and for the
/// server the secrets then the injected variables.
pub fn process_env(
    cfg: &ProcessConfig,
    ph: &Placeholders,
    tokens: &LaunchTokens,
    server_extra: Option<(&BTreeMap<String, String>, &BTreeMap<String, String>)>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = cfg.env.iter().map(|(k, v)| (k.clone(), substitute(v, ph))).collect();
    if let Some(vars) = &cfg.shared_token {
        for var in vars.names() {
            env.insert(var.to_string(), tokens.shared.clone());
        }
    }
    for (var, link) in &cfg.link_tokens {
        // Every link named by a process of this launch has a token (`link_tokens` over `DesktopConfig::link_names`).
        if let Some(token) = tokens.links.get(link) {
            env.insert(var.clone(), token.clone());
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

    fn tokens(shared: &str, links: &[(&str, &str)]) -> LaunchTokens {
        LaunchTokens { shared: shared.into(), links: links.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn sha256_matches_known_vectors_and_the_boot_code_hashes_to_its_anchor() {
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let (code, anchor) = ui_boot_code();
        let (other, _) = ui_boot_code();
        assert_eq!(code.len(), 64);
        assert!(code.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(code, other);
        assert_eq!(anchor, sha256_hex(&code));
        assert_ne!(anchor, code);
        assert_eq!(window_url(4321, "c0de"), "http://127.0.0.1:4321/#vx-local-ui=c0de");
    }

    #[test]
    fn hmac_matches_rfc_4231_and_the_proof_uses_the_key_text() {
        assert_eq!(hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        let long_key = [0xaau8; 131];
        assert_eq!(
            hmac_sha256_hex(&long_key, b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        assert_eq!(shell_proof("k", "n"), hmac_sha256_hex(b"k", b"n"));
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd") && !constant_time_eq("abc", "ab"));
    }

    #[test]
    fn every_link_gets_its_own_token() {
        let links = link_tokens(&["runner".to_string(), "voice-engine".to_string()], &random_token_hex);
        assert_eq!(links.len(), 2);
        assert_ne!(links["runner"], links["voice-engine"]);
        assert_eq!(links["runner"].len(), 64);
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
            ui_boot_anchor: "a1",
            shell_key: "k1",
        };
        let env = server_core_env(&facts);
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["NODE_PORT"], "4321");
        assert_eq!(env["CLIENT_ORIGINS"], "http://127.0.0.1:4321");
        assert_eq!(env["LOCAL_UI_SHELL_KEY"], "k1");
        assert_eq!(env["LOCAL_TRUST"], "true");
        assert_eq!(env["LOCAL_UI_BOOT_ANCHOR"], "a1");
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
                ui_boot_anchor: "a1",
                shell_key: "k1",
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
        let server = process_env(&cfg.server, &ph(), &tokens("tok", &[]), Some((&secrets, &core)));
        assert_eq!(server["LOCAL_TRUST"], "true");
        assert_eq!(server["K"], "/data");
        assert_eq!(server["ENGINE_TOKEN"], "tok");
        assert_eq!(server["CRYPT_DB_MASTER_KEY"], "s");
        let side = process_env(&cfg.sidecars[0], &ph(), &tokens("tok", &[]), None);
        assert_eq!(side["PORT"], "5000");
        assert_eq!(side["TOKEN"], "tok");
        assert!(!side.contains_key("CRYPT_DB_MASTER_KEY"));
    }

    #[test]
    fn link_tokens_reach_both_ends_of_their_link_only() {
        let cfg = parse_config(
            r#"{"productName":"A","identifier":"x","server":{"command":"n","linkTokens":{"LOCAL_RUNNER_TOKEN":"runner","ENGINE_TOKEN":"engine"}},
                "sidecars":[{"name":"engine","command":"p","port":true,"linkTokens":{"ENGINE_TOKEN":"engine"}},
                            {"name":"runner","command":"p","linkTokens":{"RUNNER_TOKEN":"runner"}},
                            {"name":"legacy","command":"p","sharedToken":"OLD_TOKEN"}]}"#,
        )
        .unwrap();
        let launch = tokens("shared", &[("runner", "tr"), ("engine", "te")]);
        let server = process_env(&cfg.server, &ph(), &launch, None);
        assert_eq!((server["LOCAL_RUNNER_TOKEN"].as_str(), server["ENGINE_TOKEN"].as_str()), ("tr", "te"));
        let engine = process_env(&cfg.sidecars[0], &ph(), &launch, None);
        assert_eq!(engine["ENGINE_TOKEN"], "te");
        assert!(!engine.values().any(|v| v == "tr" || v == "shared"), "the engine never holds the runner's token");
        let runner = process_env(&cfg.sidecars[1], &ph(), &launch, None);
        assert_eq!(runner["RUNNER_TOKEN"], "tr");
        assert!(!runner.values().any(|v| v == "te" || v == "shared"), "the runner never holds the engine's token");
        assert_eq!(process_env(&cfg.sidecars[2], &ph(), &launch, None)["OLD_TOKEN"], "shared");
        // The relay token of a sidecar (used only for one with `messages`): its own link, else the legacy shared token, else none.
        assert_eq!(launch.relay_token(&cfg.sidecars[0]).as_deref(), Some("te"));
        assert_eq!(launch.relay_token(&cfg.sidecars[2]).as_deref(), Some("shared"));
        let other = parse_config(r#"{"productName":"A","identifier":"x","server":{"command":"n"},"sidecars":[{"name":"x","command":"p","linkTokens":{"T":"engine"}}]}"#).unwrap();
        assert_eq!(launch.relay_token(&other.sidecars[0]), None, "a link not named after the sidecar is not its relay token");
    }
}
