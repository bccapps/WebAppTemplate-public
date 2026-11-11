/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionChannelDto } from './InteractionChannelDto';

/** Result of a configuration: `secret` is non-null ONCE (a webhook key at creation or rotation), never a bot token. */
export interface InteractionChannelSaveDto {
  channel: InteractionChannelDto;
  secret: string | null;
}
