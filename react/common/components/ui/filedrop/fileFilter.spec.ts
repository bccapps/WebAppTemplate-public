/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { createDragCounter, dragHasFiles, filterFiles, matchesAccept, parseAccept } from './fileFilter';

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe('parseAccept / matchesAccept', () => {
  it('parses a comma-separated list, lower-cased', () => {
    expect(parseAccept(' image/* , .PDF ,')).toEqual(['image/*', '.pdf']);
    expect(parseAccept(undefined)).toEqual([]);
  });
  it('matches extension, exact MIME type and wildcard', () => {
    const patterns = parseAccept('image/*,.pdf,audio/wav');
    expect(matchesAccept(file('a.png', 'image/png'), patterns)).toBe(true);
    expect(matchesAccept(file('REPORT.PDF', ''), patterns)).toBe(true);
    expect(matchesAccept(file('a.wav', 'audio/wav'), patterns)).toBe(true);
    expect(matchesAccept(file('a.mp3', 'audio/mpeg'), patterns)).toBe(false);
  });
  it('accepts everything without patterns', () => {
    expect(matchesAccept(file('x', ''), [])).toBe(true);
  });
});

describe('filterFiles', () => {
  const files = [file('a.png', 'image/png', 5), file('b.txt', 'text/plain'), file('c.png', 'image/png', 500)];

  it('rejects by type and by size, keeping the order', () => {
    const { accepted, rejected } = filterFiles(files, { accept: 'image/*', multiple: true, maxSizeBytes: 100 });
    expect(accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(rejected.map((r) => [r.file.name, r.reason])).toEqual([
      ['b.txt', 'type'],
      ['c.png', 'size'],
    ]);
  });

  it('keeps only the first acceptable file when not multiple', () => {
    const { accepted, rejected } = filterFiles(files, { accept: 'image/*' });
    expect(accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(rejected.map((r) => r.reason)).toEqual(['type', 'count']);
  });

  it('accepts all with no options but multiple', () => {
    expect(filterFiles(files, { multiple: true }).accepted).toHaveLength(3);
  });
});

describe('dragHasFiles', () => {
  it('detects file drags only', () => {
    expect(dragHasFiles(['Files', 'text/plain'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

describe('createDragCounter', () => {
  it('reports the first enter and the real leave across nested elements', () => {
    const counter = createDragCounter();
    expect(counter.enter()).toBe(true);
    expect(counter.enter()).toBe(false);
    expect(counter.leave()).toBe(false);
    expect(counter.leave()).toBe(true);
  });
  it('never goes below zero and can be reset', () => {
    const counter = createDragCounter();
    expect(counter.leave()).toBe(true);
    counter.enter();
    counter.enter();
    counter.reset();
    expect(counter.enter()).toBe(true);
  });
});
