/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type DefaultConfigEntry = {
  name: string;
  value: string;
  description?: string;
};

// Add project-specific defaults here (see the template README, « Needed Customizations »).
// create-project fills this array from its answers, plus the entries every new app starts with
// (`NEW_PROJECT_CONFIG_ENTRIES` in scripts/lib/project-engine.mjs, none today).
export const defaultConfigEntries: DefaultConfigEntry[] = [];
