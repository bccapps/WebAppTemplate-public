/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface TtsRequest {
  text: string;
  voice?: string;
  language?: string;
  speed?: number;
  outputFormat?: string;
}

export interface TtsResponse {
  audio: Buffer;
  contentType: string;
  durationMs?: number;
}
