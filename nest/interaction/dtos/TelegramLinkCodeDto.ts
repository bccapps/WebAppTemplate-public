/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** A one-time link code, shown once (10 minutes): `deepLink` = `https://t.me/<bot>?start=<code>`. */
export interface TelegramLinkCodeDto {
  code: string;
  deepLink: string;
  expiresAt: string;
}
