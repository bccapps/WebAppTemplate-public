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

// Add project-specific defaults here (see CLAUDE.md §9 "Getting Started").
export const defaultConfigEntries: DefaultConfigEntry[] = [];
