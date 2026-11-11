/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionChannelDto } from '../types/interactionTypes';

/** The state of a channel in one word (`ok`, `off`, `error`) and its label key. */
export function channelState(channel: InteractionChannelDto): { tone: 'ok' | 'off' | 'error'; key: string } {
  if (channel.adminDisabled) return { tone: 'error', key: 'interaction.channels.state.adminDisabled' };
  if (!channel.configured) return { tone: 'off', key: 'interaction.channels.state.notConfigured' };
  if (!channel.enabled) return { tone: 'off', key: 'interaction.channels.state.disabled' };
  if (channel.lastError) return { tone: 'error', key: 'interaction.channels.state.error' };
  return channel.ready ? { tone: 'ok', key: 'interaction.channels.state.ready' } : { tone: 'off', key: 'interaction.channels.state.notReady' };
}
