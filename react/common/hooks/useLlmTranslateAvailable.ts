/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react'
import { httpService } from '../core/http/HttpService'
import { configurationService } from '../services/ConfigurationService'
import { httpResultToPromise } from '../utils/httpResult'

// Lives in `common` (linked by every app) rather than `llm-client`, so modules that want the
// "Traduire" button (cms, user, commerce, ...) never take a compile-time dependency on a module
// they may not link — this hook/component talk to the llm-client backend purely by URL.
function getBaseUrl(): string {
  return configurationService.getApiUrl('default')
}

// Cached across every <TranslateIconButton> on the page — one HTTP round-trip per session,
// not one per rendered field. Also doubles as the "is llm-client actually wired up in this
// app" probe: an app that doesn't register LlmClientModule gets a 404 here, which resolves
// to `false` exactly like "no default model configured" does.
let cachedAvailability: Promise<boolean> | null = null

function checkAvailability(): Promise<boolean> {
  if (!cachedAvailability) {
    cachedAvailability = httpResultToPromise<{ accessId: number | null }>(
      httpService.get(`${getBaseUrl()}/llm-client-accesses/default-model`),
    )
      .then((result: any) => Boolean((result?.data ?? result)?.accessId))
      .catch(() => false)
  }
  return cachedAvailability
}

/** True once an llm-client default model is confirmed configured — gates the "Traduire" wand button everywhere. */
export function useLlmTranslateAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    checkAvailability().then((result) => {
      if (!cancelled) setAvailable(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return available
}
