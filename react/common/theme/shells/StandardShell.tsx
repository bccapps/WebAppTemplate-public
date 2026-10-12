/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * StandardShell — transparent pass-through.
 * The default shell that renders children as-is, delegating layout
 * to the app's existing PageLayout component.
 */
export function StandardShell({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
