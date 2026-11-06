/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';

/** Successful tool result: the value serialised as one JSON text block (what an LLM client reads). */
export function mcpTextResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Failed tool result the model can read and react to (`isError: true`), as opposed to a protocol error. */
export function mcpErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
