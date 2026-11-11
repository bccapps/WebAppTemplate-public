/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import { InteractionHost } from './InteractionHost';

/** Provider of the plugin (inner placement): the app's tree, plus the host listening to the user's inbox. */
export function InteractionHostProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <InteractionHost />
    </>
  );
}
