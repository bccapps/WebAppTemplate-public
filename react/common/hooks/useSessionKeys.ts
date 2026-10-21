/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useMemo, useState } from 'react';
import { appSession } from '../core/session/AppSession';

function normalizeKeys(keys: ReadonlyArray<string> = []): string[] {
  if (!keys || keys.length === 0) {
    return [];
  }
  const filtered = keys.filter(
    (key): key is string => typeof key === 'string' && key.trim().length > 0
  );
  if (filtered.length === 0) {
    return [];
  }
  const unique = Array.from(new Set(filtered.map((key) => key.trim())));
  unique.sort();
  return unique;
}

/**
 * Subscribe to session updates for the provided keys and re-render the component when they change.
 */
export function useSessionKeys(keys: ReadonlyArray<string> = []): void {
  const [, setVersion] = useState(0);
  // Callers pass a fresh array literal on every render: subscribe again only when its content changes.
  const keysKey = JSON.stringify(normalizeKeys(keys));
  const normalizedKeys = useMemo(() => JSON.parse(keysKey) as string[], [keysKey]);

  useEffect(() => {
    if (normalizedKeys.length === 0) {
      return;
    }
    const listenerIds = normalizedKeys.map((key) =>
      appSession.addEventListener(key, () => setVersion((version) => version + 1))
    );
    return () => {
      listenerIds.forEach((id) => appSession.removeEventListerner(id));
    };
  }, [normalizedKeys]);
}
