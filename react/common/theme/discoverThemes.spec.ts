/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from 'vitest'
import { collectThemes, isThemeDefinition } from './discoverThemes'
import { themeRegistry } from './themes'
import type { ThemeDefinition } from './types'

const make = (id: string, extra: Partial<ThemeDefinition> = {}): ThemeDefinition => ({
  id,
  name: id,
  shell: 'standard',
  interaction: 'standard',
  ...extra,
})

describe('collectThemes', () => {
  it('reads default exports and legacy named exports, ignores the rest', () => {
    const themes = collectThemes({
      '/b/index.ts': { default: make('b') },
      '/a/index.ts': { legacyTheme: make('a'), other: 42 },
      '/c/index.ts': { nothing: 'here' },
    })
    expect(themes.map((theme: ThemeDefinition) => theme.id)).toEqual(['a', 'b'])
  })

  it('rejects incomplete objects', () => {
    expect(isThemeDefinition({ id: 'x' })).toBe(false)
    expect(isThemeDefinition(null)).toBe(false)
    expect(isThemeDefinition(make('x'))).toBe(true)
  })
})

describe('themeRegistry default and selectable themes', () => {
  it('falls back to the shared default, hides it once the app declares its own default', () => {
    themeRegistry.register(make('default'))
    expect(themeRegistry.getDefault().id).toBe('default')
    expect(themeRegistry.getSelectable().map((theme: ThemeDefinition) => theme.id)).toContain('default')

    themeRegistry.register(make('mine', { appDefault: true }))
    expect(themeRegistry.getDefault().id).toBe('mine')
    expect(themeRegistry.getSelectable().map((theme: ThemeDefinition) => theme.id)).not.toContain('default')
  })
})
