/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { InteractionAuditEntry, InteractionAuditSink } from '../types/ports';

/** Default audit sink: one log line of ids and codes (never a target nor a secret: the entry has no field for them). */
@Injectable()
export class LoggerAuditSink implements InteractionAuditSink {
  private readonly logger = new Logger('InteractionAudit');

  async record(entry: InteractionAuditEntry): Promise<void> {
    const actor = entry.actor.userId === null ? (entry.actor.admin ? 'admin' : 'system') : `${entry.actor.admin ? 'admin' : 'user'}:${entry.actor.userId}`;
    const ticket = entry.ticket ? ` ticket=${entry.ticket.id ?? '-'} question=${entry.ticket.kind ?? '-'} source=${entry.ticket.source ?? '-'} action=${entry.ticket.actionId ?? '-'}` : '';
    const code = entry.code ? ` code=${entry.code}` : '';
    this.logger.log(`${entry.action} kind=${entry.kind} owner=${entry.ownerUserId} actor=${actor}${ticket}${code}`);
  }
}
