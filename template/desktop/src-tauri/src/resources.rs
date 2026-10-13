// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Locating the resources folder and resolving command candidates. Pure: file checks are injected.

use std::path::{Path, PathBuf};

/// Env var that points to a resources folder during development (`desktop:dev`).
pub const RESOURCES_ENV: &str = "DESKTOP_RESOURCES";

/// First folder that contains `marker`. `override_dir` (dev) is trusted as is, even without the marker.
pub fn pick_resources_dir(
    override_dir: Option<PathBuf>,
    candidates: &[PathBuf],
    marker: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if override_dir.is_some() {
        return override_dir;
    }
    candidates.iter().find(|dir| exists(&dir.join(marker))).cloned()
}

/// First usable command: a path (contains a separator) must exist, with or without `.exe` on Windows;
/// a bare name is left to the `PATH` lookup. `None` when no candidate is usable.
pub fn pick_command(candidates: &[String], exists: &dyn Fn(&Path) -> bool) -> Option<String> {
    candidates.iter().filter(|c| !c.trim().is_empty()).find_map(|c| {
        if !c.contains('/') && !c.contains('\\') {
            return Some(c.clone());
        }
        if exists(Path::new(c)) {
            return Some(c.clone());
        }
        let exe = format!("{c}.exe");
        (cfg!(windows) && exists(Path::new(&exe))).then_some(exe)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| paths.iter().any(|x| Path::new(x) == p)
    }

    #[test]
    fn override_wins_even_without_marker() {
        let got = pick_resources_dir(Some("/dev".into()), &["/a".into()], "m", &existing(&["/a/m"]));
        assert_eq!(got, Some(PathBuf::from("/dev")));
    }

    #[test]
    fn first_candidate_holding_the_marker_is_chosen() {
        let cands: Vec<PathBuf> = vec!["/portable".into(), "/bundle".into()];
        let got = pick_resources_dir(None, &cands, "back/dist/main.js", &existing(&["/bundle/back/dist/main.js"]));
        assert_eq!(got, Some(PathBuf::from("/bundle")));
        let both = existing(&["/portable/back/dist/main.js", "/bundle/back/dist/main.js"]);
        assert_eq!(pick_resources_dir(None, &cands, "back/dist/main.js", &both), Some(PathBuf::from("/portable")));
        assert_eq!(pick_resources_dir(None, &cands, "x", &existing(&[])), None);
    }

    #[test]
    fn command_candidates_prefer_existing_paths_then_path_names() {
        let list = vec!["/res/runtime/node/node".to_string(), "node".to_string()];
        assert_eq!(pick_command(&list, &existing(&["/res/runtime/node/node"])).as_deref(), Some("/res/runtime/node/node"));
        assert_eq!(pick_command(&list, &existing(&[])).as_deref(), Some("node"));
        assert_eq!(pick_command(&["/missing/bin".to_string()], &existing(&[])), None);
        assert_eq!(pick_command(&["".to_string()], &existing(&[])), None);
    }
}
