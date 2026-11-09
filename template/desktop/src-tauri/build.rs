// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

fn main() {
    // The embedded config is compiled in: rebuild when it changes.
    println!("cargo:rerun-if-changed=../desktop.config.json");
    println!("cargo:rerun-if-changed=../splash/messages.json");
    // `sidecar_message` is an app command under the permission system (`allow-sidecar-message`): a page can call it only where a capability grants it.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["sidecar_message"])),
    )
    .expect("failed to run tauri-build")
}
