/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LandingPage from './components/landingpage/LandingPage'
import { configurationService } from '@/modules_shared/common/services/ConfigurationService'
import { installPreloadErrorReload } from '@/modules_shared/common/utils/preloadReload'
import '@/themes' // register app themes with ThemeRegistry

// A tab opened before a deploy can reference a lazy chunk the new deploy removed: reload once to
// fetch the fresh index.html (guarded against loops, see preloadReload.ts).
installPreloadErrorReload({
  target: window,
  storage: sessionStorage,
  reload: () => window.location.reload(),
})

type ShellState = 'landing' | 'app'

function RootGate() {
  const useLandingPage = configurationService.get('useLandingPage') === true
  const [state, setState] = useState<ShellState>(() =>
    useLandingPage && window.location.pathname === '/' ? 'landing' : 'app',
  )

  useEffect(() => {
    if (!useLandingPage) {
      return
    }
    const handlePopState = () => {
      setState(window.location.pathname === '/' ? 'landing' : 'app')
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [useLandingPage])

  const handleLaunch = () => {
    if (!useLandingPage) {
      return
    }
    if (window.location.pathname !== '/app') {
      window.history.pushState({}, '', '/app')
    }
    setState('app')
  }

  if (!useLandingPage) {
    return <App />
  }

  if (state === 'app') {
    return <App />
  }

  return <LandingPage onLaunch={handleLaunch} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootGate />
  </StrictMode>,
)
