/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { i18n } from '../../common/core/i18n/I18n';
import { useI18nVersion } from '../../common/hooks/useI18nVersion';
import { renderText } from '../pure/text';
import type { InteractionText } from '../types/interactionTypes';

/** An `InteractionText` in the current language (re-rendered on a language switch). Plain text, never HTML. */
export function IxText({ text }: { text: InteractionText | null | undefined }) {
  useI18nVersion();
  return <>{renderText(text, (key) => i18n.get(key))}</>;
}

/** A label of the module (`interaction.*`), re-rendered on a language switch. */
export function IxLabel({ id, params }: { id: string; params?: Record<string, string | number> }) {
  useI18nVersion();
  return <>{renderText({ key: id, params }, (key) => i18n.get(key))}</>;
}
