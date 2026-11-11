/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ComponentType } from 'react';
import type { InteractionChannelDto } from '../types/interactionTypes';

/** Props of a channel settings card. */
export interface InteractionChannelCardProps {
  channel: InteractionChannelDto;
  onChanged: () => void;
}

const cards = new Map<string, ComponentType<InteractionChannelCardProps>>();

/** Registers the settings card of an app's channel kind (04 §10.3); the last registration of a kind wins. */
export function registerInteractionChannelCard(kind: string, component: ComponentType<InteractionChannelCardProps>): void {
  cards.set(kind, component);
}

export function channelCardFor(kind: string): ComponentType<InteractionChannelCardProps> | null {
  return cards.get(kind) ?? null;
}
