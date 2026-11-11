/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventStreamService } from '../../common/event-stream/EventStreamService';
import type { InteractionRealtimeEvent, InteractionRealtimePort } from '../types/ports';

/** The topic of a user's inbox: invalidations only, audience `{ userId }`. */
export const INTERACTION_INBOX_TOPIC = 'interaction.inbox';

/**
 * Default realtime port (04 §11.1): `EventStreamService.publish('interaction.inbox', { type, id?, data? }, { userId })`.
 * The event never carries a text (the stream may go through Redis): the client reads the notice over REST. Only a user
 * session (`kind: 'user'`) may subscribe to the topic; the audience then keeps each user to their own events.
 */
@Injectable()
export class EventStreamRealtime implements InteractionRealtimePort, OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(private readonly events: EventStreamService) {}

  onModuleInit(): void {
    this.unregister = this.events.registerTopicAuthorizer(INTERACTION_INBOX_TOPIC, (principal) => principal.kind === 'user' && principal.id > 0);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  publish(userId: number, event: InteractionRealtimeEvent): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    this.events.publish(INTERACTION_INBOX_TOPIC, { type: event.type, ...(event.id ? { id: event.id } : {}), ...(event.data ? { data: event.data } : {}) }, { userId });
  }
}
