/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useRef, useState } from 'react';
import { createDragCounter, dragHasFiles, filterFiles } from './fileFilter';
import type { FileFilterOptions, FileRejection } from './fileFilter';

export interface WindowDropOptions extends FileFilterOptions {
  /** Listeners are attached only while enabled (e.g. no dropping behind a modal). Default true. */
  enabled?: boolean;
  onFiles: (files: File[]) => void;
  onRejected?: (rejections: FileRejection[]) => void;
}

/**
 * Accepts files dropped anywhere on the window (the browser would otherwise navigate to the file).
 * Returns `dragging`, true while a file drag is over the window: use it to show an overlay.
 */
export function useWindowDrop(options: WindowDropOptions): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return undefined;
    const counter = createDragCounter();
    const onEnter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      if (counter.enter()) setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (dragHasFiles(event.dataTransfer?.types)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (dragHasFiles(event.dataTransfer?.types) && counter.leave()) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer?.types)) return;
      event.preventDefault();
      counter.reset();
      setDragging(false);
      const { accepted, rejected } = filterFiles(Array.from(event.dataTransfer?.files ?? []), latest.current);
      if (accepted.length > 0) latest.current.onFiles(accepted);
      if (rejected.length > 0) latest.current.onRejected?.(rejected);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      setDragging(false);
    };
  }, [enabled]);

  return { dragging };
}
