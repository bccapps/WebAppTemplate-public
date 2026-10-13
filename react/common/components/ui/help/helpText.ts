/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';

/**
 * Content of a help tooltip. Each text is given either as an i18n key (`titleId`, `bodyId`, `tipId`) or as an
 * already-translated string (`title`, `tip`, `body`) for texts that come from data (a server schema, for instance).
 * The key wins when both are given. `body` may also be a React node for rich content.
 */
export interface Help {
  titleId?: string;
  title?: string;
  bodyId?: string;
  body?: ReactNode;
  /** Practical advice, shown after the "Tip:" label. */
  tipId?: string;
  tip?: string;
}

export type Translate = (key: string, params?: (string | number)[] | null) => string;

/** Resolves a text given as key-or-string; undefined when neither is set. */
export function resolveText(id: string | undefined, text: string | undefined, translate: Translate): string | undefined {
  if (id) return translate(id);
  return text;
}

export interface ResolvedHelp {
  title?: string;
  body?: ReactNode;
  tip?: string;
}

export function resolveHelp(help: Help, translate: Translate): ResolvedHelp {
  return {
    title: resolveText(help.titleId, help.title, translate),
    body: help.bodyId ? translate(help.bodyId) : help.body,
    tip: resolveText(help.tipId, help.tip, translate),
  };
}

/** Accessible name of the "?" button: "Help: <title>" when the help has a title, a generic name otherwise. */
export function infoTipAriaLabel(resolved: ResolvedHelp, translate: Translate): string {
  return resolved.title ? translate('common.ui.infoTip.labelWithTitle', [resolved.title]) : translate('common.ui.infoTip.label');
}
