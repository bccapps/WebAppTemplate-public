/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RootGate from './components/RootGate'
import { installPreloadErrorReload } from '@/modules_shared/common/utils/preloadReload'

// A tab opened before a deploy can reference a lazy chunk the new deploy removed: reload once to
// fetch the fresh index.html (guarded against loops, see preloadReload.ts).
installPreloadErrorReload({
  target: window,
  storage: sessionStorage,
  reload: () => window.location.reload(),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootGate />
  </StrictMode>,
)
