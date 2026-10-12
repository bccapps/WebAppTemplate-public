/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

const STORAGE_KEY = 'vx_cmd_history'
const MAX_ENTRIES = 50

class CommandHistory {
  private entries: string[] = []
  private cursor = -1

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) this.entries = JSON.parse(saved)
    } catch { /* ignore */ }
  }

  push(command: string): void {
    const cmd = command.trim()
    if (!cmd) return
    // Avoid consecutive duplicates
    if (this.entries[0] === cmd) { this.reset(); return }
    this.entries.unshift(cmd)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    this.reset()
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries)) } catch { /* ignore */ }
  }

  /** Navigate backward (older). Returns the entry or null. */
  up(): string | null {
    if (this.entries.length === 0) return null
    this.cursor = Math.min(this.cursor + 1, this.entries.length - 1)
    return this.entries[this.cursor] ?? null
  }

  /** Navigate forward (newer). Returns the entry or empty string at bottom. */
  down(): string {
    if (this.cursor <= 0) { this.cursor = -1; return '' }
    this.cursor -= 1
    return this.entries[this.cursor] ?? ''
  }

  reset(): void {
    this.cursor = -1
  }

  getAll(): string[] {
    return [...this.entries]
  }
}

export const commandHistory = new CommandHistory()
