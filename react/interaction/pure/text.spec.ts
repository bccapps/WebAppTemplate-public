/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from 'vitest';
import { channelState } from './channelState';
import { fillParams, formatCountdown, renderText, safeAppPath, secondsLeft } from './text';
import type { InteractionChannelDto } from '../types/interactionTypes';

describe('texts', () => {
  const translate = (key: string) => ({ 'a.b': 'Hello {name} ({n})' })[key] ?? key;

  it('renders raw texts as is and keys with named parameters; a missing key shows', () => {
    expect(renderText({ raw: '<b>x</b>' }, translate)).toBe('<b>x</b>');
    expect(renderText({ key: 'a.b', params: { name: 'Ana', n: 2 } }, translate)).toBe('Hello Ana (2)');
    expect(renderText({ key: 'missing.key' }, translate)).toBe('missing.key');
    expect(renderText(null, translate)).toBe('');
    expect(fillParams('{x} {y}', { x: 1 })).toBe('1 {y}');
  });

  it('counts down', () => {
    expect(secondsLeft('2026-01-01T00:01:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(60);
    expect(secondsLeft('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:00Z'))).toBe(0);
    expect(secondsLeft('nonsense', 0)).toBe(0);
    expect(formatCountdown(65)).toBe('01:05');
    expect(formatCountdown(3725)).toBe('1:02:05');
  });

  it('keeps notification links on the app origin', () => {
    const origin = 'https://app.test';
    expect(safeAppPath('/a?b=1#c', origin)).toBe('/a?b=1#c');
    expect(safeAppPath('https://app.test/x', origin)).toBe('/x');
    expect(safeAppPath('https://evil.test/x', origin)).toBe('/');
    expect(safeAppPath('//evil.test/x', origin)).toBe('/');
    expect(safeAppPath('javascript:alert(1)', origin)).toBe('/');
    expect(safeAppPath(42, origin)).toBe('/');
  });
});

describe('channelState', () => {
  const base: InteractionChannelDto = { kind: 'telegram', id: 'x', enabled: true, adminDisabled: false, configured: true, verified: true, ready: true, position: 0, capabilities: [], view: {}, lastTestAt: null, lastTestStatus: null, lastTestError: null, lastUsedAt: null, lastError: null, updatedAt: null };
  it('explains the state, the admin switch first', () => {
    expect(channelState(base).tone).toBe('ok');
    expect(channelState({ ...base, adminDisabled: true, enabled: true }).key).toBe('interaction.channels.state.adminDisabled');
    expect(channelState({ ...base, configured: false }).key).toBe('interaction.channels.state.notConfigured');
    expect(channelState({ ...base, enabled: false }).tone).toBe('off');
    expect(channelState({ ...base, lastError: 'TELEGRAM_403' }).tone).toBe('error');
    expect(channelState({ ...base, ready: false }).key).toBe('interaction.channels.state.notReady');
  });
});
