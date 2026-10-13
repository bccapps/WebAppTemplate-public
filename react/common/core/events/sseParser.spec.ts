/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { SseParser, readSse, type SseMessage } from './sseParser';
import { computeBackoff } from './backoff';

describe('SseParser', () => {
  it('parses a simple event with name and id', () => {
    const parser = new SseParser();
    const out = parser.push('id: 7\nevent: event\ndata: {"a":1}\n\n');
    expect(out).toEqual([{ event: 'event', data: '{"a":1}', id: '7' }]);
    expect(parser.lastEventId).toBe('7');
  });

  it('joins multi-line data with newlines and defaults the event name to message', () => {
    const out = new SseParser().push('data: one\ndata: two\ndata\n\n');
    expect(out).toEqual([{ event: 'message', data: 'one\ntwo\n' }]);
  });

  it('ignores comments and blocks without data (heartbeat)', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\n\n')).toEqual([]);
    expect(parser.push(': c\nevent: ready\ndata: {}\n\n')).toEqual([{ event: 'ready', data: '{}' }]);
  });

  it('records retry and ignores invalid values', () => {
    const parser = new SseParser();
    parser.push('retry: 2500\n\n');
    expect(parser.retryMs).toBe(2500);
    parser.push('retry: abc\n\n');
    expect(parser.retryMs).toBe(2500);
  });

  it('handles chunks split anywhere, including inside a CRLF', () => {
    const parser = new SseParser();
    const text = 'event: event\r\ndata: x\r\n\r\nevent: resync\rdata: {}\r\r:';
    const out: SseMessage[] = [];
    for (const ch of text) out.push(...parser.push(ch));
    expect(out).toEqual([
      { event: 'event', data: 'x' },
      { event: 'resync', data: '{}' },
    ]);
  });

  it('keeps a value with colons and strips only one leading space', () => {
    const out = new SseParser().push('data:  {"t":"a:b"}\n\n');
    expect(out[0].data).toBe(' {"t":"a:b"}');
  });

  it('resets event name and id between blocks but keeps lastEventId', () => {
    const parser = new SseParser();
    parser.push('id: 1\nevent: a\ndata: x\n\n');
    const second = parser.push('data: y\n\n');
    expect(second).toEqual([{ event: 'message', data: 'y' }]);
    expect(parser.lastEventId).toBe('1');
  });

  it('does not dispatch an unfinished block', () => {
    expect(new SseParser().push('data: partial')).toEqual([]);
  });
});

describe('readSse', () => {
  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: é\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const out: SseMessage[] = [];
    await readSse(stream, new SseParser(), (m) => out.push(m));
    expect(out).toEqual([{ event: 'message', data: 'é' }]);
  });
});

describe('computeBackoff', () => {
  it('doubles from 1 s up to 30 s', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => computeBackoff(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it('applies a +-20 % random factor and never exceeds the cap', () => {
    expect(computeBackoff(0, () => 0)).toBe(800);
    expect(computeBackoff(0, () => 0.999)).toBe(1200);
    expect(computeBackoff(8, () => 0.999)).toBe(30000);
  });
});
