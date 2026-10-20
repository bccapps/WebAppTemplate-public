/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Which shell component wraps the app layout. */
export type ShellType = 'standard' | 'terminal' | 'amstrad'

/** How navigation and actions are triggered. */
export type InteractionMode = 'standard' | 'cli' | 'basic'

/** Semantic image keys — themes override only what they need. */
export type ThemeImageKey = 'logoMain' | 'logoSmall' | 'heroBackground' | 'favicon'

/** A command entry used by CLI / Amstrad themes. */
export type ThemeCommand = {
  /** Navigate to this React Router route. */
  route?: string
  /** Dispatch this named action (resolved by ThemeShell). */
  action?: string
  /** Short description shown in autocomplete / help. */
  description?: string
}

export type ThemeFontDefinition = {
  family: string
  /** Optional Google Fonts or self-hosted URL to inject as <link>. */
  url?: string
}

/**
 * A theme definition registered in the ThemeRegistry.
 * - `id` must be unique (kebab-case).
 * - `shell` and `interaction` control the paradigm of the theme.
 * - `commands` is only used by cli / basic interaction themes.
 * - `images` are merged over defaultImages — only declared keys are overridden.
 * - The theme CSS lives alongside the definition and must be imported in the
 *   definition's `index.ts` as a side-effect import so Vite bundles it.
 */
export type ThemeDefinition = {
  id: string
  /** Display name — either a plain string or an i18n key. */
  name: string
  /** Optional short description — i18n key or plain string. */
  description?: string
  shell: ShellType
  interaction: InteractionMode
  /** Fonts to load when this theme is active (injected as <link> tags). */
  fonts?: ThemeFontDefinition[]
  /** Image overrides keyed by ThemeImageKey. */
  images?: Partial<Record<ThemeImageKey, string>>
  /** Command vocabulary (cli / basic themes only). */
  commands?: Record<string, ThemeCommand>
  /** Whether this theme can be deleted by users. Built-in themes are protected. */
  builtIn?: boolean
  /**
   * The app's own theme: used when nothing is saved or the saved id is unknown, and the only one offered in the
   * selector together with the other private themes (the shared `default` is then hidden). At most one per app.
   */
  appDefault?: boolean
}
