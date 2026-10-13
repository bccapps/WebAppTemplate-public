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
    tauri_build::build()
}
