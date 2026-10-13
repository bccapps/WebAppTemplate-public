// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Download notification: the shell evaluates this script when a download ends. It fires a `desktop-download`
//! event for the front (see `useDesktopDownloads` in `react/common`) and, if the page does not handle it,
//! shows a small fallback toast.

use serde_json::{json, Value};

use crate::config::BrandConfig;
use crate::splash::{js_str, Texts};

/// Name of the DOM event (keep in sync with `DESKTOP_DOWNLOAD_EVENT` in `react/common/core/desktop`).
pub const DOWNLOAD_EVENT: &str = "desktop-download";
/// Page flag that turns the fallback toast off (keep in sync with `DESKTOP_HANDLES_DOWNLOADS_FLAG`).
pub const HANDLES_FLAG: &str = "__desktopHandlesDownloads";

/// `{ "fr": "...", "en": "..." }` for one text key.
fn per_language(texts: &Texts, key: &str) -> Value {
    Value::Object(
        texts
            .iter()
            .filter_map(|(lang, entries)| entries.get(key).map(|t| (lang.clone(), Value::String(t.clone()))))
            .collect(),
    )
}

pub fn download_js(path: &str, success: bool, texts: &Texts, brand: &BrandConfig) -> String {
    let labels = json!({ "saved": per_language(texts, "download.saved"), "failed": per_language(texts, "download.failed") });
    let colors = json!({ "background": brand.background, "foreground": brand.foreground });
    format!(
        r#"(function(p, ok, labels, colors) {{
  window.dispatchEvent(new CustomEvent("{DOWNLOAD_EVENT}", {{ detail: {{ path: p, success: ok }} }}));
  if (window.{HANDLES_FLAG}) return;
  var lang = (navigator.language || "en").slice(0, 2);
  var set = ok ? labels.saved : labels.failed;
  var name = p.split(/[\\/]/).pop() || p;
  var d = document.createElement("div");
  d.textContent = (set[lang] || set.en || "") + " " + name;
  d.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:10px 14px;border-radius:12px;" +
    "background:" + colors.background + ";color:" + colors.foreground + ";border:1px solid " + colors.foreground + "33;" +
    "font:13px -apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);transition:opacity .4s";
  document.body.appendChild(d);
  setTimeout(function() {{ d.style.opacity = 0; setTimeout(function() {{ d.remove(); }}, 500); }}, 3500);
}})({}, {success}, {labels}, {colors})"#,
        js_str(path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::splash::merged_texts;

    #[test]
    fn script_dispatches_the_event_with_escaped_path() {
        let texts = merged_texts(&Texts::new()).unwrap();
        let js = download_js(r#"C:\Users\me\a "b".png"#, true, &texts, &BrandConfig::default());
        assert!(js.contains(r#"new CustomEvent("desktop-download""#));
        assert!(js.contains(r#"window.__desktopHandlesDownloads"#));
        assert!(js.contains(r#""C:\\Users\\me\\a \"b\".png", true,"#));
    }

    #[test]
    fn labels_come_from_the_texts_in_every_language() {
        let texts = merged_texts(&Texts::new()).unwrap();
        let js = download_js("/x/a.png", false, &texts, &BrandConfig::default());
        assert!(js.contains(&texts["fr"]["download.failed"]));
        assert!(js.contains(&texts["en"]["download.saved"]));
    }
}
