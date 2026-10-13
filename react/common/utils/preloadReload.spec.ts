/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals'
import {
  PRELOAD_GUARD_RESET_MS,
  PRELOAD_RELOAD_KEY,
  claimPreloadReload,
  installPreloadErrorReload,
  releasePreloadReload,
  type PreloadGuardStorage,
} from './preloadReload'

function memoryStorage(): PreloadGuardStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const brokenStorage: PreloadGuardStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
  removeItem: () => {
    throw new Error('blocked')
  },
}

describe('claimPreloadReload / releasePreloadReload', () => {
  it('grants the ticket once, then refuses until released', () => {
    const storage = memoryStorage()
    expect(claimPreloadReload(storage)).toBe(true)
    expect(claimPreloadReload(storage)).toBe(false)
    releasePreloadReload(storage)
    expect(claimPreloadReload(storage)).toBe(true)
  })

  it('refuses (no reload loop) when the storage throws, and release never throws', () => {
    expect(claimPreloadReload(brokenStorage)).toBe(false)
    expect(() => releasePreloadReload(brokenStorage)).not.toThrow()
  })
})

describe('installPreloadErrorReload', () => {
  function setup(storage: PreloadGuardStorage) {
    const listeners = new Map<string, () => void>()
    const scheduled: Array<{ cb: () => void; ms: number }> = []
    let reloads = 0
    installPreloadErrorReload({
      target: { addEventListener: (type: string, cb: unknown) => void listeners.set(type, cb as () => void) },
      storage,
      reload: () => void (reloads += 1),
      schedule: (cb, ms) => void scheduled.push({ cb, ms }),
    })
    return { fire: () => listeners.get('vite:preloadError')?.(), scheduled, reloads: () => reloads }
  }

  it('reloads once on the first preload error and ignores the following ones', () => {
    const { fire, reloads } = setup(memoryStorage())
    fire()
    fire()
    expect(reloads()).toBe(1)
  })

  it('does not reload when the guard is already set', () => {
    const storage = memoryStorage()
    storage.setItem(PRELOAD_RELOAD_KEY, '1')
    const { fire, reloads } = setup(storage)
    fire()
    expect(reloads()).toBe(0)
  })

  it('schedules a guard reset so the next deploy gets its own retry', () => {
    const storage = memoryStorage()
    const { fire, scheduled, reloads } = setup(storage)
    fire()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].ms).toBe(PRELOAD_GUARD_RESET_MS)
    scheduled[0].cb()
    expect(storage.data.has(PRELOAD_RELOAD_KEY)).toBe(false)
    fire()
    expect(reloads()).toBe(2)
  })
})
