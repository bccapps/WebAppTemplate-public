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
//! a new-window request (`target="_blank"`, `window.open` — the engines give one only on a user gesture): `new_window_target`. Such a request
//! never opens a second window of the app: a page of the back goes to the main window only when it is a page of the app's own interface the
//! config lists (`window.sameWindowPaths`), to the system browser when the config lists it there (`window.browserPaths`: content served for
//! an agent, such as a preview), and nowhere otherwise.

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

/// Where a new-window request goes.
#[derive(Debug, PartialEq, Eq)]
pub enum NewWindowTarget {
    /// A page of the app's own interface listed in `window.sameWindowPaths` (an « open in a window » button): shown in the main window.
    MainWindow,
    /// An external http(s) site, or a page of the back listed in `window.browserPaths`: opened in the system browser.
    Browser,
    /// Anything else (another page of the back — its API, content it serves for someone else —, another loopback address, other schemes).
    Refuse,
}

/// The paths of this launch's back a new-window request may reach (`window.sameWindowPaths`, `window.browserPaths`; `path_matches`).
#[derive(Debug, Clone, Default)]
pub struct NewWindowRules {
    pub same_window: Vec<String>,
    pub browser: Vec<String>,
}

/// One segment a `*` stands for: an id or a word (letters, digits, `-`, `_`), never empty, `.`, `..` nor anything encoded.
pub fn is_plain_segment(segment: &str) -> bool {
    !segment.is_empty() && segment.len() <= 128 && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether `path` (an URL's serialized path: dot segments already resolved, `%2e%2e` included) matches `pattern`: `/`-separated segments,
/// literal (exact, case included), `*` (one plain segment) or, last only, `**` (whatever follows, nothing included). A literal or `*`
/// segment of the path must be plain: an encoded character (`%2f`, `%2e`…), an empty segment (`//x`) or a trailing `/` never match one.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    let (Some(pattern), Some(path)) = (pattern.strip_prefix('/'), path.strip_prefix('/')) else {
        return false;
    };
    let wanted: Vec<&str> = pattern.split('/').collect();
    let mut segments = path.split('/');
    for (index, want) in wanted.iter().enumerate() {
        if *want == "**" {
            return index == wanted.len() - 1;
        }
        let Some(segment) = segments.next() else {
            return false;
        };
        if !is_plain_segment(segment) || (*want != "*" && *want != segment) {
            return false;
        }
    }
    segments.next().is_none()
}

/// Pure decision for a new-window request: `back` is the back's origin when known. The main window holds the interface session and the
/// shell's `sidecar_message`: it only ever shows a page of the app's own interface listed in `sameWindowPaths` — never content the back serves
/// for an agent or a user (a preview, an attachment, an API answer), which goes to the system browser when `browserPaths` lists it, else nowhere.
pub fn new_window_target_with(url: &Url, back: Option<&str>, rules: &NewWindowRules) -> NewWindowTarget {
    match decide(url, back) {
        Decision::OpenOutside => return NewWindowTarget::Browser,
        Decision::Refuse => return NewWindowTarget::Refuse,
        Decision::Allow => {}
    }
    let is_back_page = matches!(url.scheme(), "http" | "https") && back.is_some_and(|b| url.origin().ascii_serialization() == b);
    if !is_back_page || !url.username().is_empty() || url.password().is_some() {
        return NewWindowTarget::Refuse;
    }
    let path = url.path();
    if rules.same_window.iter().any(|pattern| path_matches(pattern, path)) {
        NewWindowTarget::MainWindow
    } else if rules.browser.iter().any(|pattern| path_matches(pattern, path)) {
        NewWindowTarget::Browser
    } else {
        NewWindowTarget::Refuse
    }
}

/// `new_window_target_with` for this launch's back.
pub fn new_window_target(url: &Url, rules: &NewWindowRules) -> NewWindowTarget {
    new_window_target_with(url, BACK_ORIGIN.get().map(String::as_str), rules)
}

/// Opens an http(s) URL in the system browser (the URL is one argument, never a shell command line).
pub fn open_outside(url: &Url) {
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

    fn rules() -> NewWindowRules {
        NewWindowRules {
            same_window: vec!["/agents/*".into(), "/display/*".into(), "/settings/access".into()],
            browser: vec!["/previews/**".into()],
        }
    }

    fn target(u: &str, back: Option<&str>) -> NewWindowTarget {
        new_window_target_with(&Url::parse(u).unwrap(), back, &rules())
    }

    #[test]
    fn only_a_listed_page_of_the_interface_opens_in_the_main_window() {
        let back = Some("http://127.0.0.1:4321");
        for page in ["http://127.0.0.1:4321/agents/0b5e-41_c", "http://127.0.0.1:4321/display/s1?x=1#y", "http://127.0.0.1:4321/settings/access"] {
            assert_eq!(target(page, back), NewWindowTarget::MainWindow, "{page}");
        }
        // Another loopback port or no proven back: never the main window.
        assert_eq!(target("http://127.0.0.1:5173/agents/s1", back), NewWindowTarget::Refuse);
        assert_eq!(target("http://127.0.0.1:4321/agents/s1", None), NewWindowTarget::Refuse);
        assert_eq!(target("https://docs.example.com/", back), NewWindowTarget::Browser);
    }

    #[test]
    fn content_the_back_serves_for_an_agent_never_takes_the_main_window() {
        let back = Some("http://127.0.0.1:4321");
        // An agent's preview: the system browser (its ticket rides in the URL), never the window holding the session.
        assert_eq!(target("http://127.0.0.1:4321/previews/s1/3000/?ticket=t", back), NewWindowTarget::Browser);
        assert_eq!(target("http://127.0.0.1:4321/agents/%2e%2e/previews/s1/3000/", back), NewWindowTarget::Browser);
        for other in [
            "http://127.0.0.1:4321/api/v1/agenthub/sessions/s1/attachments/a",
            "http://127.0.0.1:4321/",
            "http://127.0.0.1:4321/agents",
            "http://127.0.0.1:4321/agents/s1/",
            "http://127.0.0.1:4321/agents/s1/x",
            "http://127.0.0.1:4321//agents/s1",
            "http://127.0.0.1:4321/agents/..%2fapi",
            "http://127.0.0.1:4321/agents/%2e%2e",
            "http://127.0.0.1:4321/agents/%73%31",
            "http://127.0.0.1:4321/Agents/s1",
            "http://127.0.0.1:4321/AGENTS/s1",
            "http://127.0.0.1:4321/PREVIEWS/s1/3000/",
            "http://127.0.0.1:4321/settings/access/../../api/v1/x",
            "http://user:pw@127.0.0.1:4321/agents/s1",
            "blob:http://127.0.0.1:4321/0b5e",
            "about:blank",
            "http://localhost:4321/agents/s1",
        ] {
            assert_eq!(target(other, back), NewWindowTarget::Refuse, "{other}");
        }
        // `//evil` is resolved by the page against the back first: another host, an external site.
        assert_eq!(target("http://evil/x", back), NewWindowTarget::Browser);
    }

    #[test]
    fn path_patterns() {
        assert!(path_matches("/agents/*", "/agents/s1"));
        assert!(!path_matches("/agents/*", "/agents/"));
        assert!(!path_matches("/agents/*", "/agents/a.b"));
        assert!(path_matches("/previews/**", "/previews/s1/3000/assets/%20x.js"));
        assert!(path_matches("/previews/**", "/previews"));
        assert!(!path_matches("/previews/**", "/preview/s1"));
        assert!(!path_matches("/a/**/b", "/a/x/b"));
        assert!(!path_matches("agents/*", "/agents/s1"));
    }

    #[test]
    fn a_navigation_never_opens_outside() {
        // `on_navigation` sees every frame and no gesture: an external site is refused there (only a new-window request opens outside).
        assert!(!on_navigation(&Url::parse("https://docs.example.com/page").unwrap()));
        assert!(!on_navigation(&Url::parse("data:text/html,x").unwrap()));
    }

    #[test]
    fn back_origin_is_the_numeric_loopback_only() {
        assert_eq!(back_origin(4321), "http://127.0.0.1:4321");
    }
}
