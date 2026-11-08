/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface SttRequest {
  audio: Buffer;
  contentType: string;
  language?: string;
  model?: string;
  /** Ask the provider to detect the spoken language when `language` is absent (providers without detection ignore it). */
  detectLanguage?: boolean;
  /** BCP-47 candidates for providers that detect among a closed list (Google: first = primary, others = alternatives). */
  candidateLanguages?: string[];
}

export interface SttResponse {
  text: string;
  confidence?: number;
  segments?: SttSegment[];
  language?: string;
}

export interface SttSegment {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}
