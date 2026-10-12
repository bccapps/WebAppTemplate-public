/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface VoiceCallParams {
  accessId: number;
  label: string;
  type: string;
  baseUrl: string;
  username: string | null;
  password: string | null;
  providerConfig: Record<string, any> | null;
}
