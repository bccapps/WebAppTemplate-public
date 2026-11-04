/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';

/** Wire format of a streamed response: one JSON object per line, or Server-Sent Events. */
export type StreamFormat = 'ndjson' | 'sse';

/**
 * Size of the random payload of the opening pad (before base64, ~16 KB on the wire).
 *
 * An intermediary between the back and the browser (Cloudflare edge suspected, plain nginx chains ruled out by
 * a local reproduction) may withhold the start of a streamed response until a volume of data has accumulated:
 * response headers and early events then reach the browser late, or not at all before the edge gives up
 * (524 at ~125 s, seen on TradeKong's AI streams and on the `event-stream` SSE, 2026-10-29 and 2026-11-04) even
 * though the server flushed headers and heartbeats immediately. A first write above that volume pushes everything
 * through at once; afterwards small events flow live. The payload is random so it stays incompressible.
 */
export const STREAM_PADDING_BYTES = 12 * 1024;

const CONTENT_TYPES: Record<StreamFormat, string> = {
  ndjson: 'application/x-ndjson; charset=utf-8',
  sse: 'text/event-stream; charset=utf-8',
};

/**
 * The opening pad, in a form every parser of the format skips: an NDJSON line `{"type":"pad","d":"…"}` (a client
 * ignoring unknown event types ignores it) or an SSE comment `: …` (ignored by `EventSource` and by any parser that
 * reads only `data:` lines).
 */
export function buildStreamPadding(format: StreamFormat): string {
  const payload = randomBytes(STREAM_PADDING_BYTES).toString('base64');
  return format === 'sse' ? `: ${payload}\n\n` : `${JSON.stringify({ type: 'pad', d: payload })}\n`;
}

export interface OpenStreamingResponseOptions {
  format: StreamFormat;
  /** Overrides the default content type of the format. */
  contentType?: string;
  /** Write the opening pad (default true). Disable only when the route is known not to cross such an intermediary. */
  padding?: boolean;
}

/** Writes a chunk and flushes it through any compression middleware; a no-op once the response has ended. */
export type StreamWrite = (chunk: string) => void;

/**
 * Starts a long-lived streamed response: no-buffering headers (`Cache-Control: no-cache, no-transform`,
 * `X-Accel-Buffering: no`), headers flushed at once, then the opening pad. Returns the `write` to use for every
 * following chunk (events and heartbeats stay the caller's: their shape depends on the protocol).
 */
export function openStreamingResponse(res: Response, options: OpenStreamingResponseOptions): StreamWrite {
  const { format, contentType = CONTENT_TYPES[format], padding = true } = options;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write: StreamWrite = (chunk) => {
    if (res.writableEnded) return;
    res.write(chunk);
    const flushable = res as Response & { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  if (padding) write(buildStreamPadding(format));
  return write;
}
