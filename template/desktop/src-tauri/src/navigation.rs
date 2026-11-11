// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Where the window may go. The window shows the waiting page, then the page of THIS launch's back (`http://127.0.0.1:<port>`), once the back
//! proved it is the one the shell started (`boot.rs` `prove_back`). Any other loopback address (another port, `localhost`, `[::1]`: a local
//! process may listen there) is refused. Only `tauri:`, `blob:` and `about:blank` pass besides (`data:`, `javascript:`, `file:`… are refused).
//! The navigation handler also sees the navigations of frames (WKWebView asks for every frame) and knows neither the frame nor a user gesture:
//! it NEVER opens anything outside — another http(s) site is refused silently there. An external link opens in the system browser only through
//! a new-window request (`target="_blank"`, `window.open` — the engines give one only on a user gesture): `on_new_window`.

use std::sync::OnceLock;

use tauri::Url;

/// `http://127.0.0.1:<port>` of this launch's back, set right before the window is sent there.
static BACK_ORIGIN: OnceLock<String> = OnceLock::new();

/// Records the back's origin (once per launch).
pub fn set_back_origin(port: u16) {
    let _ = BACK_ORIGIN.set(back_origin(port));
}

pub fn back_origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// What to do with a navigation.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Refuse,
    /// Refused in the window, opened in the system browser.
    OpenOutside,
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h == "::1" || h.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// Pure decision: `back` is the back's origin when known.
pub fn decide(url: &Url, back: Option<&str>) -> Decision {
    match url.scheme() {
        "http" | "https" => {}
        "tauri" | "blob" => return Decision::Allow,
        "about" if url.as_str() == "about:blank" => return Decision::Allow,
        _ => return Decision::Refuse,
    }
    let host = url.host_str().unwrap_or("");
    // The shell's own pages (the waiting page) on Windows and Linux.
    if host == "tauri.localhost" {
        return Decision::Allow;
    }
    if back.is_some_and(|b| url.origin().ascii_serialization() == b) {
        return Decision::Allow;
    }
    if is_loopback_host(host) {
        return Decision::Refuse;
    }
    Decision::OpenOutside
}

/// The window's navigation handler (`main.rs`): any frame, no gesture known — an external site is refused silently, never opened outside.
pub fn on_navigation(url: &Url) -> bool {
    decide(url, BACK_ORIGIN.get().map(String::as_str)) == Decision::Allow
}

/// The window's new-window handler (`main.rs`): never a second window of the app (it would not hold the interface session); an external
/// http(s) site asked by a user gesture opens in the system browser.
pub fn on_new_window(url: &Url) -> bool {
    if decide(url, BACK_ORIGIN.get().map(String::as_str)) == Decision::OpenOutside {
        open_outside(url);
    }
    false
}

/// Opens an http(s) URL in the system browser (the URL is one argument, never a shell command line).
fn open_outside(url: &Url) {
    let text = url.as_str().to_string();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&text).spawn();
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &text]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&text).spawn();
    let _ = spawned;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(url: &str, back: Option<&str>) -> Decision {
        decide(&Url::parse(url).unwrap(), back)
    }

    #[test]
    fn only_the_back_of_this_launch_is_shown() {
        let back = Some("http://127.0.0.1:4321");
        assert_eq!(d("http://127.0.0.1:4321/projects#x", back), Decision::Allow);
        for other in ["http://127.0.0.1:5173/", "http://localhost:4321/", "http://[::1]:4321/", "http://127.0.0.2:4321/", "https://127.0.0.1:4321/", "http://app.localhost:4321/"] {
            assert_eq!(d(other, back), Decision::Refuse, "{other}");
        }
        // Before the back proved itself, no loopback page at all.
        assert_eq!(d("http://127.0.0.1:4321/", None), Decision::Refuse);
    }

    #[test]
    fn shell_pages_and_listed_schemes_pass_external_sites_go_outside() {
        assert_eq!(d("tauri://localhost/index.html", None), Decision::Allow);
        assert_eq!(d("http://tauri.localhost/index.html", None), Decision::Allow);
        assert_eq!(d("blob:http://127.0.0.1:4321/0b5e", None), Decision::Allow);
        assert_eq!(d("about:blank", None), Decision::Allow);
        assert_eq!(d("https://docs.example.com/page", Some("http://127.0.0.1:4321")), Decision::OpenOutside);
    }

    #[test]
    fn other_schemes_are_refused() {
        for other in ["data:text/html,<script>1</script>", "javascript:alert(1)", "file:///etc/passwd", "about:srcdoc", "ftp://example.com/x", "vscode://x"] {
            assert_eq!(d(other, None), Decision::Refuse, "{other}");
        }
    }

    #[test]
    fn a_navigation_never_opens_outside() {
        // `on_navigation` sees every frame and no gesture: an external site is refused there (only `on_new_window` opens outside).
        assert!(!on_navigation(&Url::parse("https://docs.example.com/page").unwrap()));
        assert!(!on_navigation(&Url::parse("data:text/html,x").unwrap()));
    }

    #[test]
    fn back_origin_is_the_numeric_loopback_only() {
        assert_eq!(back_origin(4321), "http://127.0.0.1:4321");
    }
}
