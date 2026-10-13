// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Splash screen bridge: builds the JavaScript the shell evaluates in the waiting page, and merges its texts.
//! The page (`splash/index.html`) owns the rendering; messages are sent as ids + parameters and translated there.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::config::BrandConfig;

pub type Texts = BTreeMap<String, BTreeMap<String, String>>;
pub type Params = Vec<(String, String)>;

/// Default messages of the waiting page and of the download fallback (fr + en).
const DEFAULT_TEXTS: &str = include_str!("../../splash/messages.json");

pub fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Default texts overlaid with the config's per-language overrides.
pub fn merged_texts(overrides: &Texts) -> Result<Texts, String> {
    let mut texts: Texts = serde_json::from_str(DEFAULT_TEXTS).map_err(|e| format!("splash/messages.json: {e}"))?;
    for (lang, entries) in overrides {
        texts.entry(lang.clone()).or_default().extend(entries.clone());
    }
    Ok(texts)
}

fn params_json(params: &Params) -> Value {
    Value::Object(params.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

pub fn init_js(product_name: &str, brand: &BrandConfig, texts: &Texts) -> String {
    let payload = json!({ "productName": product_name, "brand": {
        "background": brand.background, "foreground": brand.foreground, "accent": brand.accent }, "texts": texts });
    format!("window.desktopSplash && window.desktopSplash.init({payload})")
}

pub fn status_js(id: &str, params: &Params) -> String {
    format!("window.desktopSplash && window.desktopSplash.status({}, {})", js_str(id), params_json(params))
}

pub fn error_js(title_id: &str, detail_id: &str, params: &Params, log: &str) -> String {
    format!(
        "window.desktopSplash && window.desktopSplash.error({}, {}, {}, {})",
        js_str(title_id),
        js_str(detail_id),
        params_json(params),
        js_str(log)
    )
}

/// Runs a script in the main window, if it exists.
pub fn eval(app: &AppHandle, script: String) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&script);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_texts_cover_both_languages_with_the_same_keys() {
        let texts = merged_texts(&Texts::new()).unwrap();
        let fr: Vec<_> = texts["fr"].keys().collect();
        let en: Vec<_> = texts["en"].keys().collect();
        assert_eq!(fr, en);
        assert!(texts["en"].contains_key("status.starting"));
    }

    #[test]
    fn overrides_replace_and_add_keys() {
        let over = Texts::from([("en".to_string(), BTreeMap::from([("status.starting".to_string(), "Hello".to_string()), ("custom".to_string(), "x".to_string())]))]);
        let texts = merged_texts(&over).unwrap();
        assert_eq!(texts["en"]["status.starting"], "Hello");
        assert_eq!(texts["en"]["custom"], "x");
        assert!(texts["fr"]["status.starting"].len() > 1);
    }

    #[test]
    fn js_is_escaped_json() {
        let params = vec![("name".to_string(), "a\"b".to_string())];
        assert_eq!(status_js("status.x", &params), r#"window.desktopSplash && window.desktopSplash.status("status.x", {"name":"a\"b"})"#);
        let err = error_js("t", "d", &Vec::new(), "line1\nline2");
        assert!(err.ends_with(r#".error("t", "d", {}, "line1\nline2")"#));
        assert!(init_js("My App", &BrandConfig::default(), &Texts::new()).contains(r##""accent":"#ff5b37""##));
    }
}
