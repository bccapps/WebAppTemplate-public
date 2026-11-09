// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! « Message to a sidecar »: the one generic Tauri command (`sidecar_message`) a page of the webview can call to talk to a sidecar's loopback HTTP
//! server. A page served by a REMOTE origin (an https hub the window shows) cannot `fetch("http://127.0.0.1:<port>")` (blocked as mixed content /
//! local network access), and the port is random per launch anyway. The shell knows the port and the shared token, so it relays.
//!
//! Nothing is open by default: a sidecar is reachable only through the exact `"METHOD /path"` entries of its `messages` list in
//! `desktop.config.json`, the command is a Tauri permission (`allow-sidecar-message`, granted to the local back's origin and to the origins listed in
//! `messaging.origins`), the target is always `127.0.0.1`, and the sidecar's shared token is added by the shell (the page never sees it).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_REPLY_BYTES: usize = 1024 * 1024;
const METHODS: [&str; 4] = ["GET", "POST", "PUT", "DELETE"];

/// Where a sidecar listens and what may be asked of it.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    /// Bearer token the shell adds (`None` = the sidecar has no `sharedToken`).
    pub token: Option<String>,
    /// Exact `"METHOD /path"` entries.
    pub allowed: Vec<String>,
}

/// Tauri state: the reachable sidecars by name, filled by the start-up sequence.
#[derive(Default)]
pub struct SidecarEndpoints(pub Mutex<BTreeMap<String, Endpoint>>);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidecarRequest {
    pub sidecar: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SidecarReply {
    pub status: u16,
    /// The JSON the sidecar answered, else its text.
    pub body: Value,
}

/// `"POST /v1/pair"`: a known method, an absolute path with no query, no `..`, no space or control character.
pub fn valid_message_entry(entry: &str) -> Result<(), String> {
    let (method, path) = entry.split_once(' ').ok_or_else(|| format!("\"{entry}\": expected \"METHOD /path\""))?;
    if !METHODS.contains(&method) {
        return Err(format!("\"{entry}\": method must be one of {}", METHODS.join(", ")));
    }
    valid_path(path).map_err(|e| format!("\"{entry}\": {e}"))
}

pub fn valid_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("path must start with '/'".into());
    }
    if path.contains("..") || path.contains('?') || path.contains('#') || path.chars().any(|c| c.is_control() || c == ' ' || c == '\\') {
        return Err("path must not contain '..', '?', '#', spaces or control characters".into());
    }
    Ok(())
}

pub fn is_allowed(allowed: &[String], method: &str, path: &str) -> bool {
    allowed.iter().any(|entry| entry.split_once(' ').is_some_and(|(m, p)| m == method && p == path))
}

/// The HTTP/1.0 request sent to the loopback server (`Connection: close`: the reply ends with the connection).
pub fn build_request(method: &str, path: &str, port: u16, token: Option<&str>, body: Option<&str>) -> Vec<u8> {
    let mut head = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    if let Some(body) = body {
        out.extend_from_slice(body.as_bytes());
    }
    out
}

/// Status and body of a raw HTTP response.
pub fn parse_reply(raw: &[u8]) -> Result<SidecarReply, String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("incomplete answer")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| "unreadable answer")?;
    let status = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).and_then(|s| s.parse::<u16>().ok()).ok_or("no status in the answer")?;
    let text = String::from_utf8_lossy(&raw[split + 4..]).trim().to_string();
    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    Ok(SidecarReply { status, body })
}

fn exchange(port: u16, request: &[u8]) -> Result<Vec<u8>, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("the sidecar does not answer: {e}"))?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(|e| e.to_string())?;
    stream.write_all(request).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > MAX_REPLY_BYTES {
                    return Err("answer too large".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(raw)
}

/// Checks a request against the endpoint table and relays it. Pure but for the loopback connection.
pub fn relay(endpoints: &BTreeMap<String, Endpoint>, request: &SidecarRequest) -> Result<SidecarReply, String> {
    let endpoint = endpoints.get(&request.sidecar).ok_or_else(|| format!("unknown or unreachable sidecar \"{}\"", request.sidecar))?;
    let method = request.method.to_ascii_uppercase();
    valid_path(&request.path)?;
    if !is_allowed(&endpoint.allowed, &method, &request.path) {
        return Err(format!("{method} {} is not allowed for sidecar \"{}\"", request.path, request.sidecar));
    }
    let body = match &request.body {
        Some(value) => {
            let text = value.to_string();
            if text.len() > MAX_BODY_BYTES {
                return Err("request body too large".into());
            }
            Some(text)
        }
        None => None,
    };
    let raw = exchange(endpoint.port, &build_request(&method, &request.path, endpoint.port, endpoint.token.as_deref(), body.as_deref()))?;
    parse_reply(&raw)
}

/// The command. The blocking socket work runs off the UI thread.
#[tauri::command]
pub async fn sidecar_message(endpoints: State<'_, SidecarEndpoints>, request: SidecarRequest) -> Result<SidecarReply, String> {
    let snapshot = endpoints.0.lock().map_err(|_| "state poisoned".to_string())?.clone();
    tauri::async_runtime::spawn_blocking(move || relay(&snapshot, &request)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn entries_are_exact_method_and_path() {
        assert!(valid_message_entry("POST /v1/pair").is_ok());
        assert!(valid_message_entry("GET /v1/status").is_ok());
        for bad in ["/v1/pair", "PATCH /v1/pair", "POST v1/pair", "POST /v1/../x", "POST /v1/a?b=1", "POST /v1/a b", "POST "] {
            assert!(valid_message_entry(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn only_listed_requests_pass() {
        let allowed = vec!["POST /v1/pair".to_string(), "GET /v1/status".to_string()];
        assert!(is_allowed(&allowed, "POST", "/v1/pair"));
        assert!(!is_allowed(&allowed, "GET", "/v1/pair"));
        assert!(!is_allowed(&allowed, "POST", "/v1/pair/"));
        assert!(!is_allowed(&allowed, "POST", "/v1/pairs"));
        assert!(!is_allowed(&[], "GET", "/v1/status"));
    }

    #[test]
    fn request_carries_the_token_and_the_body_length() {
        let text = String::from_utf8(build_request("POST", "/v1/pair", 7841, Some("tok"), Some("{\"a\":1}"))).unwrap();
        assert!(text.starts_with("POST /v1/pair HTTP/1.0\r\nHost: 127.0.0.1:7841\r\n"));
        assert!(text.contains("Authorization: Bearer tok\r\n"));
        assert!(text.contains("Content-Length: 7\r\n"));
        assert!(text.ends_with("\r\n\r\n{\"a\":1}"));
        let bare = String::from_utf8(build_request("GET", "/v1/status", 1, None, None)).unwrap();
        assert!(!bare.contains("Authorization") && !bare.contains("Content-Length"));
    }

    #[test]
    fn reply_is_status_plus_json_or_text() {
        let json = parse_reply(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"deviceId\":\"d\"}\n").unwrap();
        assert_eq!(json, SidecarReply { status: 200, body: serde_json::json!({ "deviceId": "d" }) });
        let text = parse_reply(b"HTTP/1.0 401 Unauthorized\r\n\r\nunauthorized\n").unwrap();
        assert_eq!(text, SidecarReply { status: 401, body: Value::String("unauthorized".into()) });
        assert!(parse_reply(b"garbage").is_err());
    }

    fn serve_once(reply: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (port, handle)
    }

    fn table(port: u16) -> BTreeMap<String, Endpoint> {
        BTreeMap::from([("voice-engine".to_string(), Endpoint { port, token: Some("secret-token".into()), allowed: vec!["POST /v1/pair".into()] })])
    }

    fn request(path: &str) -> SidecarRequest {
        SidecarRequest { sidecar: "voice-engine".into(), method: "post".into(), path: path.into(), body: Some(serde_json::json!({ "hubUrl": "https://hub.example.com", "code": "ABCD2345" })) }
    }

    #[test]
    fn relays_an_allowed_request_with_the_shell_token_and_returns_the_answer() {
        let (port, server) = serve_once("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"deviceId\":\"dev-1\"}");
        let reply = relay(&table(port), &request("/v1/pair")).unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["deviceId"], "dev-1");
        let seen = server.join().unwrap();
        assert!(seen.starts_with("POST /v1/pair HTTP/1.0"));
        assert!(seen.contains("Authorization: Bearer secret-token"));
        assert!(seen.contains("\"code\":\"ABCD2345\""));
    }

    #[test]
    fn refuses_what_is_not_listed_before_any_connection() {
        // Port 1 would refuse a connection: an error about the list proves nothing was attempted.
        let err = relay(&table(1), &request("/v1/status")).unwrap_err();
        assert!(err.contains("not allowed"), "{err}");
        let err = relay(&table(1), &SidecarRequest { sidecar: "runner".into(), ..request("/v1/pair") }).unwrap_err();
        assert!(err.contains("unknown or unreachable"), "{err}");
        let err = relay(&table(1), &request("/v1/../admin")).unwrap_err();
        assert!(err.contains("'..'"), "{err}");
    }

    #[test]
    fn refuses_a_body_that_is_too_large() {
        let mut big = request("/v1/pair");
        big.body = Some(Value::String("x".repeat(MAX_BODY_BYTES + 1)));
        assert!(relay(&table(1), &big).unwrap_err().contains("too large"));
    }
}
