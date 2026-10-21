/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { configurationService } from '@/modules_shared/common/services/ConfigurationService';
import { cryptService } from '@/modules_shared/common/services/CryptService';
import { localeService } from '@/modules_shared/common/services/LocaleService';
import type { PreloadEntry } from '@/modules_shared/common/plugins/AppPlugin';

/**
 * Services of the core, always loaded (blocking). An app that does not need one removes it here (e.g. `crypt` when it
 * does not use transport encryption); plugins add theirs through `preload` (`mode: 'background'` = not awaited).
 */
export const coreServices: PreloadEntry[] = [
  { key: 'ConfigurationService', service: configurationService },
  { key: 'CryptService', service: cryptService },
  { key: 'LocaleService', service: localeService },
];
