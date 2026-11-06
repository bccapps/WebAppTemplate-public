/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { mcpErrorResult, mcpTextResult } from './mcpResults';

describe('mcpResults', () => {
  it('mcpTextResult serialises the value as one JSON text block, not an error', () => {
    const result = mcpTextResult({ a: 1, b: [null] });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"a":1,"b":[null]}' }] });
    expect(result.isError).toBeUndefined();
  });

  it('mcpErrorResult returns the message as a readable tool error', () => {
    expect(mcpErrorResult('nope')).toEqual({ isError: true, content: [{ type: 'text', text: 'nope' }] });
  });
});
