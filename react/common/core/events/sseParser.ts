/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** One dispatched Server-Sent Event. */
export interface SseMessage {
  /** `event:` field, `message` when absent. */
  event: string;
  /** `data:` lines joined with `\n`. */
  data: string;
  /** `id:` field of this block, when present. */
  id?: string;
}

const LINE_END = /\r\n|\n|\r/;

/**
 * Incremental parser of the `text/event-stream` format (WHATWG): multi-line data, comments (`: ping`), `id`, `event`
 * and `retry`, with `\n`, `\r` and `\r\n` terminators, possibly split across chunks. Blocks without data are not
 * dispatched (heartbeats, lone `retry`).
 */
export class SseParser {
  /** Last `retry:` value in milliseconds, if the server sent one. */
  retryMs: number | undefined;
  /** Last `id:` seen; persists across blocks. */
  lastEventId: string | undefined;

  private buffer = '';
  private dataLines: string[] = [];
  private eventName = '';
  private blockId: string | undefined;

  /** Feeds decoded text, returns the events completed by it. */
  push(text: string): SseMessage[] {
    this.buffer += text;
    const out: SseMessage[] = [];
    let line = this.nextLine();
    while (line !== null) {
      const message = this.processLine(line);
      if (message) out.push(message);
      line = this.nextLine();
    }
    return out;
  }

  /** Extracts one complete line from the buffer; a trailing `\r` waits for a possible `\n`. */
  private nextLine(): string | null {
    const match = LINE_END.exec(this.buffer);
    if (!match) return null;
    const end = match.index + match[0].length;
    if (match[0] === '\r' && end === this.buffer.length) return null;
    const line = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(end);
    return line;
  }

  private processLine(line: string): SseMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.applyField(field, value);
    return null;
  }

  private applyField(field: string, value: string): void {
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id' && !value.includes('\0')) {
      this.blockId = value;
      this.lastEventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
  }

  private dispatch(): SseMessage | null {
    const hasData = this.dataLines.length > 0;
    const message: SseMessage = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
    if (this.blockId !== undefined) message.id = this.blockId;
    this.dataLines = [];
    this.eventName = '';
    this.blockId = undefined;
    return hasData ? message : null;
  }
}

/** Reads a stream to its end (or until it is aborted/errors), calling `onMessage` for each event. */
export async function readSse(
  stream: ReadableStream<Uint8Array>,
  parser: SseParser,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.push(decoder.decode(value, { stream: true })).forEach(onMessage);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by an abort
    }
  }
}
