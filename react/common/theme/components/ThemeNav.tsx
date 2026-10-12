/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react'
import { useVisualTheme } from '../hooks/useVisualTheme'

export type NavItem = {
  id: string
  label: ReactNode
  /** CLI command hint for this nav item (e.g. "/tradingbot"). */
  command?: string
  icon?: ReactNode
  onClick?: () => void
  href?: string
  active?: boolean
}

export type ThemeNavProps = {
  items: NavItem[]
  /** Render function for standard mode (sidebar, topbar, etc.). */
  renderStandard: (items: NavItem[]) => ReactNode
  className?: string
}

/**
 * ThemeNav — semantic navigation component.
 *
 * In `standard` interaction mode: delegates to `renderStandard` so each app
 * controls its own sidebar / topbar implementation.
 *
 * In `cli` / `basic` interaction mode: renders a compact command-reference
 * footer listing available navigation commands (navigation is typed, not clicked).
 */
export function ThemeNav({ items, renderStandard, className }: ThemeNavProps) {
  const { activeTheme } = useVisualTheme()

  if (activeTheme.interaction === 'standard') {
    return <>{renderStandard(items)}</>
  }

  // CLI mode: show a command-hint bar (navigation is via the prompt)
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: '0.5rem 1rem',
        flexWrap: 'wrap',
        padding: '0.35rem 0.75rem',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface-muted)',
        fontSize: '0.72rem',
        fontFamily: 'var(--font-primary)',
        color: 'var(--color-text-muted)',
      }}
    >
      {items.map((item) => (
        <span key={item.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          {item.command && (
            <code
              style={{
                color: 'var(--color-primary)',
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
            >
              {item.command}
            </code>
          )}
          {item.command && <span style={{ opacity: 0.5 }}>→</span>}
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  )
}
