/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
// One name, two meanings: the class decorator (value) and the interface it promises (type).
import { AccountErasureParticipant } from '../../common/types/ExtensionPoints';
import { UserInteractionService } from './UserInteractionService';

/**
 * The account erasure of `user` reaches this module (04 §16.2) without either importing the other: once an account is closed (and
 * again when the deep sweep reaches an account closed earlier), `user` calls `onAccountErased`, which runs `forgetUser` — channels,
 * secrets, push subscriptions, Telegram links, preferences, notices, deliveries, the recipient rows (its lone open tickets cancelled).
 * Idempotent: on an account already forgotten every step finds nothing. Without the `user` module, nothing calls it.
 */
@Injectable()
@AccountErasureParticipant()
export class InteractionAccountErasure implements AccountErasureParticipant {
  readonly erasureKey = 'interaction';

  constructor(private readonly interaction: UserInteractionService) {}

  async onAccountErased(userId: number): Promise<void> {
    await this.interaction.forgetUser(userId);
  }
}
