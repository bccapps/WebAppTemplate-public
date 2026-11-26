/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
// One name, two meanings each: the class decorator (value) and the interface it promises (type).
import { AccountErasureParticipant, AccountPurgeParticipant, type AccountPurgeColumnRule } from '../../common/types/ExtensionPoints';
import { UserInteractionService } from './UserInteractionService';

/**
 * How the account purge of `user` (physical deletion, `AccountPurgeService`) treats this module's columns where its safety net's default
 * is wrong: these rows are the account's own (a Telegram link code it asked for, its Telegram link), nullable only because a row may wait
 * for its account — left with a NULL owner they would be orphans, so they are DELETED (the default would null them). The module's NOT NULL
 * columns (`user_id` of channels, preferences, notices, deliveries…) are deleted by default, `interaction_ticket.answered_by` is nulled.
 */
export const INTERACTION_PURGE_COLUMN_RULES: readonly AccountPurgeColumnRule[] = [
  { table: 'interaction_link_code', column: 'user_id', action: 'delete' },
  { table: 'interaction_telegram_link', column: 'user_id', action: 'delete' },
];

/**
 * The account erasure of `user` reaches this module (04 §16.2) without either importing the other: once an account is closed (and
 * again when the deep sweep reaches an account closed earlier), `user` calls `onAccountErased`, which runs `forgetUser` — channels,
 * secrets, push subscriptions, Telegram links, preferences, notices, deliveries, the recipient rows (its lone open tickets cancelled).
 * Idempotent: on an account already forgotten every step finds nothing. Without the `user` module, nothing calls it.
 *
 * Also an account purge participant (`@AccountPurgeParticipant()`, 2026-11-25) with column rules only
 * ({@link INTERACTION_PURGE_COLUMN_RULES}): every app linking this module and `user` classifies these tables the same way.
 */
@Injectable()
@AccountErasureParticipant()
@AccountPurgeParticipant()
export class InteractionAccountErasure implements AccountErasureParticipant, AccountPurgeParticipant {
  readonly erasureKey = 'interaction';
  readonly purgeKey = 'interaction';
  readonly purgeColumnRules = INTERACTION_PURGE_COLUMN_RULES;

  constructor(private readonly interaction: UserInteractionService) {}

  async onAccountErased(userId: number): Promise<void> {
    await this.interaction.forgetUser(userId);
  }
}
