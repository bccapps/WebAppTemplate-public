/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { i18n } from '../core/i18n/I18n';

/** Forces a re-render on language switch — needed by any component that reads `i18n.getLang()`
 *  or `i18n.get()` directly at render time, since neither is itself reactive state. */
export function useI18nVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const id = i18n.addEventListener('languageChanged', () => setVersion((v) => v + 1));
    return () => { i18n.removeEventListerner(id); };
  }, []);
  return version;
}
