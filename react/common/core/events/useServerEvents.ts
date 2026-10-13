/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useRef } from 'react';
import { eventStreamClient } from './eventStream';
import type { ServerEvent } from './types';

/**
 * Calls `handler` for every server event of `topics` while the component is mounted. The handler may change between
 * renders without resubscribing; the subscription only changes with the set of topics.
 */
export function useServerEvents(topics: string[], handler: (event: ServerEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = [...new Set(topics)].sort().join(',');

  useEffect(() => {
    if (key === '') return;
    return eventStreamClient.subscribe(key.split(','), (event) => handlerRef.current(event));
  }, [key]);
}
