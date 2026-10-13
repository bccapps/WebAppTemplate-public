/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import { describe, it, expect } from 'vitest';
import { computePeaks, downmixToMono, encodeWavMono, fractionInBox, rmsLevel, seekFractionForKey } from './audioMath';

describe('computePeaks', () => {
  it('takes the max absolute value per bin and normalizes to the loudest', () => {
    const samples = new Float32Array([0.1, -0.2, 0.5, 0.25, -1, 0.3, 0, 0]);
    const peaks = computePeaks(samples, 4);
    [0.2, 0.5, 1, 0].forEach((v, i) => expect(peaks[i]).toBeCloseTo(v, 5));
  });
  it('returns zeros for silence and handles empty input', () => {
    expect(computePeaks(new Float32Array(8), 2)).toEqual([0, 0]);
    expect(computePeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
  });
  it('gives exactly `bins` values even when samples are fewer than bins', () => {
    expect(computePeaks(new Float32Array([0.5, 1]), 5)).toHaveLength(5);
  });
  it('folds the remainder into the last bin', () => {
    expect(computePeaks(new Float32Array([0, 0, 0, 0, 1]), 2)).toEqual([0, 1]);
  });
});

describe('downmixToMono', () => {
  it('averages channels', () => {
    const mono = downmixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 0, -0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0, -0.75]);
  });
  it('copies a single channel without aliasing it', () => {
    const channel = new Float32Array([0.1, 0.2]);
    const mono = downmixToMono([channel]);
    mono[0] = 9;
    expect(channel[0]).toBeCloseTo(0.1);
  });
  it('uses the shortest channel and tolerates no channel', () => {
    expect(downmixToMono([new Float32Array(3), new Float32Array(2)])).toHaveLength(2);
    expect(downmixToMono([])).toHaveLength(0);
  });
});

describe('encodeWavMono', () => {
  const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));
  const ascii = (b: ArrayBuffer, from: number, to: number) => String.fromCharCode(...new Uint8Array(b, from, to - from));

  it('writes the 44-byte header byte by byte', () => {
    const wav = encodeWavMono(new Float32Array([0, 0]), 16000);
    expect(wav.byteLength).toBe(48);
    expect(bytes(wav).slice(0, 44)).toEqual([
      0x52, 0x49, 0x46, 0x46, // RIFF
      40, 0, 0, 0, // chunk size = 36 + 4
      0x57, 0x41, 0x56, 0x45, // WAVE
      0x66, 0x6d, 0x74, 0x20, // "fmt "
      16, 0, 0, 0, // fmt chunk size
      1, 0, // PCM
      1, 0, // mono
      0x80, 0x3e, 0, 0, // 16000 Hz
      0x00, 0x7d, 0, 0, // byte rate 32000
      2, 0, // block align
      16, 0, // bits per sample
      0x64, 0x61, 0x74, 0x61, // data
      4, 0, 0, 0, // data size
    ]);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
  });
  it('quantizes samples to little-endian int16 and clamps', () => {
    const wav = encodeWavMono(new Float32Array([1, -1, 0.5, 2, -2]), 8000);
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
    expect(bytes(wav).slice(44, 46)).toEqual([0xff, 0x7f]);
  });
  it('encodes an empty recording as a header only', () => {
    expect(encodeWavMono(new Float32Array(0), 44100).byteLength).toBe(44);
  });
});

describe('rmsLevel', () => {
  it('scales the RMS and clamps to 1', () => {
    expect(rmsLevel(new Float32Array([0.1, -0.1, 0.1, -0.1]))).toBeCloseTo(0.4);
    expect(rmsLevel(new Float32Array([1, 1]))).toBe(1);
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });
});

describe('fractionInBox', () => {
  it('maps a pointer to 0..1 and clamps outside', () => {
    expect(fractionInBox(150, 100, 200)).toBe(0.25);
    expect(fractionInBox(50, 100, 200)).toBe(0);
    expect(fractionInBox(500, 100, 200)).toBe(1);
    expect(fractionInBox(10, 0, 0)).toBe(0);
  });
});

describe('seekFractionForKey', () => {
  it('steps, pages and jumps with clamping', () => {
    expect(seekFractionForKey(0.5, 'ArrowRight')).toBeCloseTo(0.55);
    expect(seekFractionForKey(0.02, 'ArrowLeft')).toBe(0);
    expect(seekFractionForKey(0.5, 'PageUp', 0.1)).toBeCloseTo(0.7);
    expect(seekFractionForKey(0.5, 'Home')).toBe(0);
    expect(seekFractionForKey(0.5, 'End')).toBe(1);
  });
  it('ignores other keys', () => {
    expect(seekFractionForKey(0.5, 'a')).toBeNull();
  });
});
