/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository, type FindOptionsWhere } from 'typeorm';
import { InteractionSendCounterEntity, type InteractionSendKind } from '../entities/InteractionSendCounterEntity';
import { InteractionError } from '../errors/InteractionError';
import { hashTarget } from '../pure/codes';
import { InteractionConfig } from './InteractionConfig';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 2 * DAY_MS;

export type SendCap = 'user' | 'ip' | 'target' | 'global';

export interface SendRequester {
  userId: number;
  ip?: string | null;
  /** E-mail codes: the recipient (only its SHA-256 is stored). */
  target?: string | null;
}

interface Cap {
  cap: SendCap;
  key: string;
  windowMs: number;
  where: FindOptionsWhere<InteractionSendCounterEntity>;
}

/**
 * Persisted caps on what a user can make the app send on their command (04 §6 `interaction_send_counter`, extracted from
 * AgentHub `NotificationSendQuotaService`): « record, then count ». A send is recorded, every cap is counted with it, and
 * over a cap the record is withdrawn and the send refused (`RATE_LIMITED { cap }` + `Retry-After`). Two concurrent sends
 * at the edge may both be refused, never both admitted past a cap. Survives a restart (rows, not memory).
 */
@Injectable()
export class InteractionSendQuotaService {
  constructor(
    @InjectRepository(InteractionSendCounterEntity) private readonly sends: Repository<InteractionSendCounterEntity>,
    private readonly config: InteractionConfig,
  ) {}

  /** Records one send or throws `RATE_LIMITED`. */
  async take(kind: InteractionSendKind, requester: SendRequester, now: number = Date.now()): Promise<void> {
    const ip = requester.ip ? requester.ip.slice(0, 64) : null;
    const targetHash = requester.target ? hashTarget(requester.target) : null;
    const row = await this.sends.save(this.sends.create({ kind, userId: requester.userId, ip, targetHash, at: new Date(now) }));
    for (const cap of this.caps(kind, requester.userId, ip, targetHash)) {
      const count = await this.sends.count({ where: { ...cap.where, kind, at: MoreThan(new Date(now - cap.windowMs)) } });
      if (count > this.config.number(cap.key, 0, 10_000_000)) {
        await this.sends.delete({ id: row.id });
        throw new InteractionError('RATE_LIMITED', { cap: cap.cap }, cap.windowMs / 1000);
      }
    }
  }

  /** Rows past the 48 h retention (daily purge). */
  async purge(now: number = Date.now()): Promise<void> {
    await this.sends.delete({ at: LessThan(new Date(now - RETENTION_MS)) });
  }

  private caps(kind: InteractionSendKind, userId: number, ip: string | null, targetHash: string | null): Cap[] {
    if (kind === 'link_code') return [{ cap: 'user', key: 'interaction_linkCodesPerUserHour', windowMs: HOUR_MS, where: { userId } }];
    const email = kind === 'email_code';
    const caps: Cap[] = [{ cap: 'user', key: email ? 'interaction_emailCodesPerUserHour' : 'interaction_testsPerUserHour', windowMs: HOUR_MS, where: { userId } }];
    if (ip) caps.push({ cap: 'ip', key: email ? 'interaction_emailCodesPerIpHour' : 'interaction_testsPerIpHour', windowMs: HOUR_MS, where: { ip } });
    if (email && targetHash) caps.push({ cap: 'target', key: 'interaction_emailCodesPerAddressDay', windowMs: DAY_MS, where: { targetHash } });
    caps.push({ cap: 'global', key: email ? 'interaction_emailCodesGlobalHour' : 'interaction_testsGlobalHour', windowMs: HOUR_MS, where: {} });
    return caps;
  }
}
