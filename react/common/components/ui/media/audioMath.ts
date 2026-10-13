/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Peak of each of `bins` equal slices of `samples`, normalized so the loudest slice is 1 (all 0 for silence). */
export function computePeaks(samples: Float32Array, bins = 120): number[] {
  const count = Math.max(1, Math.floor(bins));
  const size = Math.max(1, Math.floor(samples.length / count));
  const out: number[] = [];
  let top = 0;
  for (let b = 0; b < count; b++) {
    const end = b === count - 1 ? samples.length : Math.min(samples.length, (b + 1) * size);
    let max = 0;
    for (let i = b * size; i < end; i++) max = Math.max(max, Math.abs(samples[i]));
    out.push(max);
    top = Math.max(top, max);
  }
  return top > 0 ? out.map((v) => v / top) : out;
}

/** Average of all channels into one (channels may have different lengths: the shortest wins). */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();
  const length = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

/** 16-bit PCM mono WAV file (44-byte RIFF header, little endian); samples are clamped to [-1, 1]. */
export function encodeWavMono(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return buffer;
}

/** Root-mean-square level of a time-domain buffer, scaled by `gain` and clamped to 0..1 (microphone meter). */
export function rmsLevel(buffer: Float32Array, gain = 4): number {
  if (buffer.length === 0) return 0;
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.min(1, Math.sqrt(sum / buffer.length) * gain);
}

/** Position 0..1 of a pointer inside a horizontal box. */
export function fractionInBox(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width));
}

/** New position after a keyboard event on a seek bar, or null when the key is not a seek key. */
export function seekFractionForKey(current: number, key: string, step = 0.05): number | null {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(current + step);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(current - step);
    case 'PageUp':
      return clamp(current + step * 2);
    case 'PageDown':
      return clamp(current - step * 2);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
}
