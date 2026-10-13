/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { getAppPlugins } from './pluginRegistry';
import { useMenuContext } from './useMenuContext';

interface PluginHeaderActionsProps {
  /** Only the end of the header is supported for now. */
  placement?: 'end';
}

/**
 * Renders the `HeaderActions` of every plugin. Use it in any header (the template's, or an app's own top bar):
 * `<PluginHeaderActions placement="end" />`.
 */
export function PluginHeaderActions(_props: PluginHeaderActionsProps) {
  const { isAuth, isAdmin } = useMenuContext();
  return (
    <>
      {getAppPlugins().map((plugin) => (plugin.HeaderActions ? <plugin.HeaderActions key={plugin.id} isAuth={isAuth} isAdmin={isAdmin} /> : null))}
    </>
  );
}
