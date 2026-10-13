/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { computePeaks, downmixToMono, encodeWavMono } from './audioMath';

async function decode(blob: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close().catch(() => undefined);
  }
}

function monoOf(decoded: AudioBuffer): Float32Array {
  return downmixToMono(Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)));
}

/** Decodes any format the browser can read (m4a, webm, mp3, ...) and returns a mono 16-bit WAV file. */
export async function toMonoWavFile(blob: Blob, name: string): Promise<File> {
  const decoded = await decode(blob);
  const wav = encodeWavMono(monoOf(decoded), decoded.sampleRate);
  return new File([wav], `${name.replace(/\.[^.]+$/, '')}.wav`, { type: 'audio/wav' });
}

/** Waveform peaks and duration of a local audio file (preview before upload). */
export async function readAudioPeaks(file: Blob, bins = 120): Promise<{ peaks: number[]; duration: number }> {
  const decoded = await decode(file);
  return { peaks: computePeaks(monoOf(decoded), bins), duration: decoded.duration };
}
