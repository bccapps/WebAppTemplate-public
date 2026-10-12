/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ThemeCommand } from '../types'

export type ResolvedCommand =
  | { type: 'route'; path: string }
  | { type: 'action'; name: string }
  | { type: 'unknown'; input: string }

export type CommandSuggestion = {
  command: string
  description: string
}

class CommandRegistry {
  private commands: Map<string, ThemeCommand> = new Map()
  private actionHandlers: Map<string, () => void> = new Map()

  /** Register commands from a theme (merged, last-write-wins). */
  registerThemeCommands(themeCommands: Record<string, ThemeCommand>): void {
    Object.entries(themeCommands).forEach(([cmd, def]) => {
      this.commands.set(cmd.toLowerCase(), def)
    })
  }

  /** Register app-level action handlers. */
  registerActionHandler(actionName: string, handler: () => void): void {
    this.actionHandlers.set(actionName, handler)
  }

  unregisterActionHandler(actionName: string): void {
    this.actionHandlers.delete(actionName)
  }

  /** Clear all theme commands (called when theme changes). */
  clearThemeCommands(): void {
    this.commands.clear()
  }

  /** Parse raw input and resolve to a route or action. */
  resolve(raw: string): ResolvedCommand {
    const normalised = raw.trim().toLowerCase()
    const match = this.commands.get(normalised)
    if (!match) return { type: 'unknown', input: raw.trim() }
    if (match.route) return { type: 'route', path: match.route }
    if (match.action) return { type: 'action', name: match.action }
    return { type: 'unknown', input: raw.trim() }
  }

  /** Dispatch a resolved command. Returns false if not handled. */
  dispatch(raw: string, navigate: (path: string) => void): boolean {
    const resolved = this.resolve(raw)
    if (resolved.type === 'route') {
      navigate(resolved.path)
      return true
    }
    if (resolved.type === 'action') {
      const handler = this.actionHandlers.get(resolved.name)
      if (handler) {
        handler()
        return true
      }
    }
    return false
  }

  /** Return suggestions matching a prefix (for autocomplete). */
  suggest(prefix: string, limit = 8): CommandSuggestion[] {
    const p = prefix.trim().toLowerCase()
    const results: CommandSuggestion[] = []
    for (const [cmd, def] of this.commands) {
      if (cmd.startsWith(p)) {
        results.push({ command: cmd, description: def.description ?? '' })
        if (results.length >= limit) break
      }
    }
    return results
  }

  getAll(): CommandSuggestion[] {
    return Array.from(this.commands.entries()).map(([cmd, def]) => ({
      command: cmd,
      description: def.description ?? '',
    }))
  }
}

export const commandRegistry = new CommandRegistry()
