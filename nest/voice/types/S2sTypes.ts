/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface S2sConfig {
  inputLanguage?: string;
  outputLanguage?: string;
  voice?: string;
  systemPrompt?: string;
  model?: string;
}

export interface S2sSession {
  sendAudio(chunk: Buffer): void;
  onAudioResponse(cb: (chunk: Buffer, contentType: string) => void): void;
  onTranscript(cb: (text: string, isFinal: boolean) => void): void;
  onError(cb: (error: Error) => void): void;
  close(): void;
}
