// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Generic desktop shell.
//!
//! Opens a waiting page, starts the sidecars then the project's back (Node) on free loopback ports, waits until
//! they answer, then shows the front served by the back (same origin). On exit it stops every process tree.
//! Everything project specific lives in `desktop.config.json`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod boot;
mod config;
mod downloads;
mod environment;
mod health;
mod logs;
mod process;
mod resources;
mod splash;

use std::env as std_env;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{webview::DownloadEvent, window::Color, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder};

use config::{parse_config, parse_hex_color, DesktopConfig};
use process::{install_signal_handlers, stop_all, Processes, SIGNALED};
use splash::{merged_texts, Texts};

/// Config compiled into the binary; `DESKTOP_CONFIG=<file>` overrides it at run time (development).
const EMBEDDED_CONFIG: &str = include_str!("../../desktop.config.json");

fn load_config() -> DesktopConfig {
    let text = match std_env::var_os("DESKTOP_CONFIG") {
        Some(path) => std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read DESKTOP_CONFIG: {e}")),
        None => EMBEDDED_CONFIG.to_string(),
    };
    parse_config(&text).unwrap_or_else(|e| panic!("{e}"))
}

fn window_theme(name: &str) -> Option<Theme> {
    match name {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

/// Requests a normal exit when a signal was caught, so the processes are stopped.
fn watch_signals(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(200));
        if SIGNALED.load(Ordering::SeqCst) {
            app.exit(0);
            return;
        }
    });
}

/// Download handler: logs the transfer and notifies the page (WKWebView ignores `<a download>` without it).
fn download_handler(
    logs_dir: PathBuf,
    texts: Texts,
    brand: config::BrandConfig,
) -> impl Fn(tauri::Webview, DownloadEvent) -> bool + Send + Sync + 'static {
    let last_destination: Mutex<String> = Mutex::new(String::new());
    move |webview, event| {
        match event {
            DownloadEvent::Requested { url, destination } => {
                // wry's default destination: Downloads folder, suggested name, no overwrite.
                logs::shell_log(&logs_dir, &format!("download requested: {url} -> {}", destination.display()));
                *last_destination.lock().unwrap() = destination.display().to_string();
            }
            DownloadEvent::Finished { url, path, success } => {
                // On macOS the event does not always carry the path: fall back to the requested destination.
                let shown = path.map(|p| p.display().to_string()).unwrap_or_else(|| last_destination.lock().unwrap().clone());
                logs::shell_log(&logs_dir, &format!("download finished: {url} -> {shown} (success: {success})"));
                let _ = webview.eval(downloads::download_js(&shown, success, &texts, &brand));
            }
            _ => {}
        }
        true
    }
}

fn build_window(app: &tauri::App, cfg: &DesktopConfig) -> tauri::Result<()> {
    let logs_dir = app.path().app_local_data_dir().map(|d| d.join("logs")).unwrap_or_else(|_| std_env::temp_dir());
    let texts = merged_texts(&cfg.splash.texts).unwrap_or_default();
    let (r, g, b) = parse_hex_color(&cfg.splash.brand.background).unwrap_or((13, 11, 10));
    let w = &cfg.window;
    // Built here (not in tauri.conf.json) to hook the download handler.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(w.title.as_deref().unwrap_or(&cfg.product_name))
        .inner_size(w.width, w.height)
        .min_inner_size(w.min_width, w.min_height)
        .center()
        .theme(window_theme(&w.theme))
        .background_color(Color(r, g, b, 255))
        // Otherwise Tauri intercepts dropped files and the UI's HTML5 drag and drop receives nothing.
        .disable_drag_drop_handler()
        .on_download(download_handler(logs_dir, texts, cfg.splash.brand.clone()))
        .build()?;
    Ok(())
}

fn main() {
    // Linux: WebKitGTK's DMA-BUF renderer shows a blank window or crashes with some proprietary NVIDIA drivers.
    // Disabled unless explicitly set.
    #[cfg(target_os = "linux")]
    if std_env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std_env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    install_signal_handlers();
    let cfg = Arc::new(load_config());

    let mut builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // Single instance: a second launch brings the existing window to the front.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    let setup_cfg = cfg.clone();
    builder
        .setup(move |app| {
            app.manage(Processes(Mutex::new(Vec::new())));
            watch_signals(app.handle().clone());
            build_window(app, &setup_cfg)?;
            let (handle, cfg) = (app.handle().clone(), setup_cfg.clone());
            thread::spawn(move || boot::boot(handle, cfg));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialise the application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Processes>() {
                    stop_all(std::mem::take(&mut *state.0.lock().unwrap()));
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_config_is_valid() {
        let cfg = parse_config(EMBEDDED_CONFIG).unwrap();
        assert!(!cfg.product_name.is_empty());
        assert!(merged_texts(&cfg.splash.texts).is_ok());
    }

    #[test]
    fn embedded_config_matches_tauri_conf() {
        let cfg = parse_config(EMBEDDED_CONFIG).unwrap();
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["productName"], cfg.product_name.as_str());
        assert_eq!(conf["identifier"], cfg.identifier.as_str());
    }

    #[test]
    fn theme_names() {
        assert_eq!(window_theme("dark"), Some(Theme::Dark));
        assert_eq!(window_theme("light"), Some(Theme::Light));
        assert_eq!(window_theme("system"), None);
    }
}
