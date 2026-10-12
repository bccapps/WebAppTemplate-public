/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useState } from 'react'

// BeforeInstallPromptEvent is not in the standard lib — extend EventTarget manually.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * usePwaInstallPrompt — Android "Add to Home Screen" prompt hook.
 *
 * iOS does not fire `beforeinstallprompt` (users must use the Share menu),
 * so on iOS `canInstall` is always false. Use `isIos` to show a manual hint.
 *
 * Usage:
 * ```tsx
 * const { canInstall, isIos, isInstalled, prompt } = usePwaInstallPrompt()
 *
 * if (isIos && !isInstalled) return <IosInstallHint />
 * if (canInstall) return <button onClick={prompt}>Install app</button>
 * ```
 */
export function usePwaInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(false)

  const isIos =
    typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !(window.navigator as any).standalone

  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault()
      setPromptEvent(e as BeforeInstallPromptEvent)
    }
    const handleInstalled = () => {
      setIsInstalled(true)
      setPromptEvent(null)
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const prompt = useCallback(async () => {
    if (!promptEvent) return
    await promptEvent.prompt()
    const { outcome } = await promptEvent.userChoice
    if (outcome === 'accepted') setIsInstalled(true)
    setPromptEvent(null)
  }, [promptEvent])

  return {
    /** True on Android when the browser is ready to show the install prompt. */
    canInstall: !!promptEvent && !isInstalled,
    /** True on iOS Safari — show a manual "tap Share → Add to Home Screen" hint. */
    isIos,
    /** True after the user has installed the app. */
    isInstalled,
    /** Trigger the native Android install dialog. */
    prompt,
  }
}
