/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';
import { STREAM_PADDING_BYTES, buildStreamPadding, openStreamingResponse } from './streamingResponse';

const MIN_WIRE_LENGTH = Math.ceil((STREAM_PADDING_BYTES * 4) / 3);

function fakeResponse(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  const written: string[] = [];
  const res = {
    writableEnded: false,
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
    flushHeaders: jest.fn(),
    write: jest.fn((c: string) => { written.push(c); return true; }),
    ...overrides,
  };
  return { res: res as unknown as Response, headers, written };
}

describe('buildStreamPadding', () => {
  it('ndjson: one line of type "pad", large enough to push the stream through a holding intermediary', () => {
    const line = buildStreamPadding('ndjson');
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line).type).toBe('pad');
    expect(line.length).toBeGreaterThanOrEqual(MIN_WIRE_LENGTH);
  });

  it('sse: a comment event, skipped by EventSource and by parsers reading only data: lines', () => {
    const block = buildStreamPadding('sse');
    expect(block.startsWith(': ')).toBe(true);
    expect(block.endsWith('\n\n')).toBe(true);
    expect(block.split('\n').every((l) => !l.startsWith('data:'))).toBe(true);
    expect(block.length).toBeGreaterThanOrEqual(MIN_WIRE_LENGTH);
  });

  it('is random on every call so it cannot be compressed away', () => {
    expect(buildStreamPadding('ndjson')).not.toBe(buildStreamPadding('ndjson'));
  });
});

describe('openStreamingResponse', () => {
  it('sets the no-buffering headers, flushes them, then writes the pad first', () => {
    const { res, headers, written } = fakeResponse();
    openStreamingResponse(res, { format: 'ndjson' });

    expect(headers['Content-Type']).toBe('application/x-ndjson; charset=utf-8');
    expect(headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(headers['X-Accel-Buffering']).toBe('no');
    expect((res.flushHeaders as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((res.write as jest.Mock).mock.invocationCallOrder[0]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).type).toBe('pad');
  });

  it('uses the SSE content type and an SSE pad', () => {
    const { res, headers, written } = fakeResponse();
    openStreamingResponse(res, { format: 'sse' });
    expect(headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(written[0].startsWith(': ')).toBe(true);
  });

  it('honours contentType and padding: false', () => {
    const { res, headers, written } = fakeResponse();
    openStreamingResponse(res, { format: 'ndjson', contentType: 'application/jsonl', padding: false });
    expect(headers['Content-Type']).toBe('application/jsonl');
    expect(written).toHaveLength(0);
  });

  it('write() writes then flushes through a compression middleware, and is a no-op once ended', () => {
    const flush = jest.fn();
    const { res, written } = fakeResponse({ flush });
    const write = openStreamingResponse(res, { format: 'ndjson', padding: false });

    write('{"type":"x"}\n');
    expect(written).toEqual(['{"type":"x"}\n']);
    expect(flush).toHaveBeenCalledTimes(1);

    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    write('late\n');
    expect(written).toHaveLength(1);
  });
});
