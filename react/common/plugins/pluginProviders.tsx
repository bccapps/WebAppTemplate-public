/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import type { AppPlugin } from './AppPlugin';

/**
 * Wrap `tree` with the Providers of the plugins of one placement (default `outer`). `plugins` is sorted by ascending
 * `order`: the first one is the outermost.
 */
export function withPluginProviders(tree: ReactNode, plugins: ReadonlyArray<AppPlugin>, placement: 'outer' | 'inner' = 'outer'): ReactNode {
  return plugins.reduceRight<ReactNode>((acc, plugin) => {
    if (!plugin.Provider || (plugin.providerPlacement ?? 'outer') !== placement) return acc;
    return <plugin.Provider key={plugin.id}>{acc}</plugin.Provider>;
  }, tree);
}
