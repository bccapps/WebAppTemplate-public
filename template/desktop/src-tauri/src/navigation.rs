// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Where the window may go. The window shows the waiting page, then the page of THIS launch's back (`http://127.0.0.1:<port>`), once the back
//! proved it is the one the shell started (`boot.rs` `prove_back`). Any other loopback address (another port, `localhost`, `[::1]`: a local
//! process may listen there) is refused; another http(s) site is opened in the system browser instead of the window. Other schemes (`blob:`,
//! `data:`, `about:`, the shell's own pages) are left alone. The handler also sees the navigations of frames (WKWebView asks for every frame).

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
        _ => return Decision::Allow,
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

/// The window's navigation handler (`main.rs`).
pub fn on_navigation(url: &Url) -> bool {
    match decide(url, BACK_ORIGIN.get().map(String::as_str)) {
        Decision::Allow => true,
        Decision::Refuse => false,
        Decision::OpenOutside => {
            open_outside(url);
            false
        }
    }
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
    fn shell_pages_and_other_schemes_pass_external_sites_go_outside() {
        assert_eq!(d("tauri://localhost/index.html", None), Decision::Allow);
        assert_eq!(d("http://tauri.localhost/index.html", None), Decision::Allow);
        assert_eq!(d("blob:http://127.0.0.1:4321/0b5e", None), Decision::Allow);
        assert_eq!(d("about:blank", None), Decision::Allow);
        assert_eq!(d("https://docs.example.com/page", Some("http://127.0.0.1:4321")), Decision::OpenOutside);
    }

    #[test]
    fn back_origin_is_the_numeric_loopback_only() {
        assert_eq!(back_origin(4321), "http://127.0.0.1:4321");
    }
}
