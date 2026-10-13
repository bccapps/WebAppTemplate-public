/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * One-shot reload after a failed lazy-chunk load.
 *
 * A tab opened before a deploy can reference a chunk hash that the new deploy removed: Vite then
 * fires `vite:preloadError`. Reloading once fetches the fresh `index.html`. The guard lives in
 * `sessionStorage` so a persistent failure (a real outage) cannot reload in a loop; it is cleared
 * shortly after a load that raised no error, so the next deploy gets its own single retry.
 */

export const PRELOAD_RELOAD_KEY = 'vite-preload-reloaded'
/** Delay after which a load that raised no preload error clears the guard. */
export const PRELOAD_GUARD_RESET_MS = 5000

export type PreloadGuardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface PreloadReloadDeps {
  /** Usually `window`. */
  target: Pick<EventTarget, 'addEventListener'>
  /** Usually `sessionStorage`; may throw (private mode, blocked storage). */
  storage: PreloadGuardStorage
  /** Usually `() => window.location.reload()`. */
  reload: () => void
  /** Usually `window.setTimeout`; injectable for tests. */
  schedule?: (callback: () => void, delayMs: number) => unknown
}

/**
 * Take the single reload ticket. Returns true (and records it) only the first time; false when
 * the guard is already set or the storage is unusable (reloading without a guard could loop).
 */
export function claimPreloadReload(storage: PreloadGuardStorage): boolean {
  try {
    if (storage.getItem(PRELOAD_RELOAD_KEY)) return false
    storage.setItem(PRELOAD_RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** Clear the guard; never throws. */
export function releasePreloadReload(storage: PreloadGuardStorage): void {
  try {
    storage.removeItem(PRELOAD_RELOAD_KEY)
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** Register the `vite:preloadError` handler and schedule the guard reset. */
export function installPreloadErrorReload(deps: PreloadReloadDeps): void {
  const { target, storage, reload } = deps
  const schedule = deps.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  target.addEventListener('vite:preloadError', () => {
    if (claimPreloadReload(storage)) reload()
  })
  schedule(() => releasePreloadReload(storage), PRELOAD_GUARD_RESET_MS)
}
