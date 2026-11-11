/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Result of a test send: a code (04 §12.3), never a message. */
export interface ChannelTestResultDto {
  ok: boolean;
  code: string | null;
}
