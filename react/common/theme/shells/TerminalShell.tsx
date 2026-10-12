/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { commandRegistry } from '../commands/CommandRegistry'
import { commandHistory } from '../commands/CommandHistory'
import { useVisualTheme } from '../hooks/useVisualTheme'

type TerminalLine =
  | { type: 'output'; text: string }
  | { type: 'error'; text: string }
  | { type: 'command'; text: string }

/**
 * TerminalShell — CLI-paradigm shell for retro-cli and similar themes.
 * Renders a full-screen terminal with:
 * - Content area (page output rendered as normal React)
 * - Command prompt bar at the bottom (↑↓ history, Tab autocomplete)
 */
export function TerminalShell({ children, appName = 'VX' }: { children: React.ReactNode; appName?: string }) {
  const navigate = useNavigate()
  const { activeTheme } = useVisualTheme()
  const [input, setInput] = useState('')
  const [lines, setLines] = useState<TerminalLine[]>([
    { type: 'output', text: `${appName} Terminal — type /help for commands` },
  ])
  const [suggestions, setSuggestions] = useState<{ command: string; description: string }[]>([])
  const [selectedSugg, setSelectedSugg] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const appendLine = useCallback((line: TerminalLine) => {
    setLines((prev) => [...prev.slice(-200), line])
  }, [])

  const handleSubmit = useCallback(() => {
    const cmd = input.trim()
    if (!cmd) return
    commandHistory.push(cmd)
    appendLine({ type: 'command', text: cmd })
    setInput('')
    setSuggestions([])
    setSelectedSugg(-1)

    const handled = commandRegistry.dispatch(cmd, navigate)
    if (!handled) {
      appendLine({ type: 'error', text: `Unknown command: ${cmd}. Type /help for available commands.` })
    }
  }, [input, navigate, appendLine])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (selectedSugg >= 0 && suggestions[selectedSugg]) {
          setInput(suggestions[selectedSugg].command)
          setSuggestions([])
          setSelectedSugg(-1)
        } else {
          handleSubmit()
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (suggestions.length > 0) {
          setSelectedSugg((prev) => Math.max(0, prev - 1))
        } else {
          const prev = commandHistory.up()
          if (prev !== null) setInput(prev)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (suggestions.length > 0) {
          setSelectedSugg((prev) => Math.min(suggestions.length - 1, prev + 1))
        } else {
          setInput(commandHistory.down())
        }
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (suggestions.length === 1) {
          setInput(suggestions[0].command)
          setSuggestions([])
          setSelectedSugg(-1)
        } else if (suggestions.length > 0) {
          setSelectedSugg((prev) => (prev + 1) % suggestions.length)
        }
        return
      }
      if (e.key === 'Escape') {
        setSuggestions([])
        setSelectedSugg(-1)
      }
    },
    [handleSubmit, suggestions, selectedSugg],
  )

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setInput(val)
    setSelectedSugg(-1)
    if (val.trim()) {
      setSuggestions(commandRegistry.suggest(val.trim()))
    } else {
      setSuggestions([])
    }
  }, [])

  // Scroll content to bottom on new lines
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [lines])

  // Re-register theme commands when theme changes
  useEffect(() => {
    if (activeTheme.commands) {
      commandRegistry.registerThemeCommands(activeTheme.commands)
    }
  }, [activeTheme])

  return (
    <div className="retro-terminal-shell" onClick={() => inputRef.current?.focus()}>
      {/* Titlebar */}
      <div className="retro-terminal-shell__titlebar">
        <span className="retro-terminal-shell__titlebar-logo">{appName}</span>
        <span>terminal</span>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{activeTheme.name}</span>
      </div>

      {/* Content: actual React page rendered here */}
      <div className="retro-terminal-shell__content" ref={contentRef}>
        {/* Terminal output lines */}
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.82rem',
              lineHeight: 1.4,
              color:
                line.type === 'error'
                  ? '#ff3333'
                  : line.type === 'command'
                    ? 'rgba(0,255,65,0.6)'
                    : '#00ff41',
              marginBottom: '0.1rem',
            }}
          >
            {line.type === 'command' ? `$ ${line.text}` : line.text}
          </div>
        ))}

        {/* React page content rendered below terminal lines */}
        <div style={{ marginTop: '1rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(0,255,65,0.15)' }}>
          {children}
        </div>
      </div>

      {/* Command prompt */}
      <div className="retro-terminal-shell__prompt-bar" style={{ position: 'relative' }}>
        {/* Autocomplete */}
        {suggestions.length > 0 && (
          <div className="retro-terminal-shell__autocomplete">
            {suggestions.map((s, i) => (
              <div
                key={s.command}
                className={`retro-terminal-shell__autocomplete-item${i === selectedSugg ? ' is-selected' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setInput(s.command); setSuggestions([]); setSelectedSugg(-1) }}
              >
                {s.command}
                {s.description && (
                  <span className="retro-terminal-shell__autocomplete-desc"> — {s.description}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <span className="retro-terminal-shell__prompt-symbol">$</span>
        <input
          ref={inputRef}
          className="retro-terminal-shell__input"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          placeholder="type a command…"
        />
      </div>
    </div>
  )
}
