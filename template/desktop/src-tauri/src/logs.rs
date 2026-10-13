// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Log files of the shell and of the managed processes: rotation, tail, shell journal.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// `server.log` becomes `server.previous.log` (the previous run is kept, older ones are dropped).
pub fn previous_log_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "log".into());
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    path.with_file_name(format!("{stem}.previous{ext}"))
}

/// Moves an existing log to its `.previous` name; never fails the caller.
pub fn rotate_log(path: &Path) {
    if path.exists() {
        let _ = fs::rename(path, previous_log_path(path));
    }
}

/// Rotates, then opens the log for appending (creating its folder).
pub fn open_rotated_log(path: &Path) -> Result<File, String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    rotate_log(path);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Cannot open log {}: {e}", path.display()))
}

/// Last `max_lines` lines of a text.
pub fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}

/// Last lines of a log file; empty when unreadable.
pub fn tail(path: &Path, max_lines: usize) -> String {
    fs::read_to_string(path).map(|t| tail_lines(&t, max_lines)).unwrap_or_default()
}

/// Appends a line to `<logs_dir>/shell.log`.
pub fn shell_log(logs_dir: &Path, line: &str) {
    let _ = fs::create_dir_all(logs_dir);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(logs_dir.join("shell.log")) {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desktop-shell-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn previous_name_keeps_the_extension() {
        assert_eq!(previous_log_path(Path::new("/l/server.log")), PathBuf::from("/l/server.previous.log"));
        assert_eq!(previous_log_path(Path::new("/l/engine")), PathBuf::from("/l/engine.previous"));
    }

    #[test]
    fn rotation_keeps_only_the_last_previous_run() {
        let dir = tmp("rotate");
        let log = dir.join("server.log");
        fs::write(&log, "run1").unwrap();
        drop(open_rotated_log(&log).unwrap());
        fs::write(&log, "run2").unwrap();
        drop(open_rotated_log(&log).unwrap());
        assert_eq!(fs::read_to_string(dir.join("server.previous.log")).unwrap(), "run2");
        assert_eq!(fs::read_to_string(&log).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_returns_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a", 5), "a");
        assert_eq!(tail_lines("", 5), "");
        assert_eq!(tail(Path::new("/definitely/missing.log"), 3), "");
    }

    #[test]
    fn shell_log_appends() {
        let dir = tmp("shell");
        shell_log(&dir, "one");
        shell_log(&dir, "two");
        assert_eq!(fs::read_to_string(dir.join("shell.log")).unwrap(), "one\ntwo\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
