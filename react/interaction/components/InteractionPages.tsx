/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BrowserNotificationPrompt, InteractionInboxPanel } from './InteractionInbox';
import { InteractionChannelsAdminPanel, InteractionChannelsPanel, InteractionPrefsPanel } from './InteractionPanels';
import { IxLabel } from './IxText';

/** The user's page of the plugin route: inbox, channels, preferences. */
export default function InteractionSettingsPage() {
  return (
    <div className="ix-page">
      <h2><IxLabel id="interaction.page.title" /></h2>
      <BrowserNotificationPrompt />
      <InteractionInboxPanel />
      <InteractionChannelsPanel />
      <InteractionPrefsPanel />
    </div>
  );
}

/** The administrators' page of the plugin route. */
export function InteractionAdminPage() {
  return (
    <div className="ix-page">
      <InteractionChannelsAdminPanel />
    </div>
  );
}
