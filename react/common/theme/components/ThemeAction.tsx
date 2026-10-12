/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { CSSProperties, ReactNode } from 'react'
import { useVisualTheme } from '../hooks/useVisualTheme'

export type ThemeActionProps = {
  /** Semantic intent label shown as button text or command hint. */
  label: ReactNode
  /** Called when the action is triggered (button click or command dispatch). */
  onAction: () => void
  /** CLI command hint shown instead of a button in cli/basic interaction modes. */
  command?: string
  variant?: 'primary' | 'outline' | 'danger' | 'ghost' | 'success'
  disabled?: boolean
  loading?: boolean
  style?: CSSProperties
  className?: string
}

/**
 * ThemeAction — semantic action component.
 *
 * In `standard` interaction mode: renders a button with the given variant.
 * In `cli` / `basic` interaction mode: renders a command hint chip instead.
 *
 * Use this for primary actions (form submit, launch bot, confirm modal) that
 * may be replaced by commands in CLI themes.
 */
export function ThemeAction({
  label,
  onAction,
  command,
  variant = 'primary',
  disabled,
  loading,
  style,
  className,
}: ThemeActionProps) {
  const { activeTheme } = useVisualTheme()

  // CLI / Amstrad mode: show command hint instead of a button
  if (activeTheme.interaction !== 'standard' && command) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontFamily: 'inherit',
          fontSize: '0.82rem',
          color: 'var(--color-text-muted)',
          ...style,
        }}
        className={className}
      >
        <code
          style={{
            background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.15rem 0.45rem',
            fontSize: '0.78rem',
            color: 'var(--color-primary)',
            fontFamily: 'var(--font-primary)',
          }}
        >
          {command}
        </code>
        <span style={{ opacity: 0.65 }}>{label}</span>
      </span>
    )
  }

  // Standard mode: render a button
  const btnClass = [
    variant === 'primary' ? 'primary-btn' : '',
    variant === 'outline' ? 'outline-btn' : '',
    variant === 'danger' ? 'danger-btn' : '',
    variant === 'ghost' ? 'ghost-btn' : '',
    variant === 'success' ? 'success-btn' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={btnClass} onClick={onAction} disabled={disabled || loading} style={style}>
      {loading ? (
        <span className="btn-loading">
          <span className="button-spinner" />
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  )
}
