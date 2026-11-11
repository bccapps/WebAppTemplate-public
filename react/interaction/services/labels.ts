/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { i18n } from '../../common/core/i18n/I18n';
import { renderText } from '../pure/text';

/** The text of a label for an attribute (`title`, `aria-label`, `placeholder`), named `{param}`s filled. */
export function ixLabel(id: string, params?: Record<string, string | number>): string {
  return renderText({ key: id, params }, (key) => i18n.get(key));
}
