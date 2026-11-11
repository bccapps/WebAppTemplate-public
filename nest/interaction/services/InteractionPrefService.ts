/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/dbErrors';
import type { InteractionPrefDto } from '../dtos/InteractionPrefDto';
import { InteractionUserPrefEntity } from '../entities/InteractionUserPrefEntity';
import { InteractionError } from '../errors/InteractionError';
import { parsePrefBody, type PrefPatch } from '../pure/bodies';
import type { PlanPrefs } from '../pure/deliveryPlan';
import type { InteractionCategory } from '../types/interactionTypes';
import { INTERACTION_REALTIME, type InteractionRealtimePort } from '../types/ports';
import { InteractionConfig, isTimeZone } from './InteractionConfig';

/** A user's preferences (04 §6 `interaction_user_pref`): quiet hours, time zone, critical bypass, routing, in-app display. */
@Injectable()
export class InteractionPrefService {
  constructor(
    @InjectRepository(InteractionUserPrefEntity) private readonly prefs: Repository<InteractionUserPrefEntity>,
    private readonly config: InteractionConfig,
    @Inject(INTERACTION_REALTIME) private readonly realtime: InteractionRealtimePort,
  ) {}

  /** What the delivery plan reads (defaults when the user has no row). */
  async planPrefs(userId: number): Promise<PlanPrefs> {
    const row = await this.prefs.findOne({ where: { userId } });
    return {
      quietHoursStart: row?.quietHoursStart ?? null,
      quietHoursEnd: row?.quietHoursEnd ?? null,
      timezone: row?.timezone && isTimeZone(row.timezone) ? row.timezone : this.config.defaultTimezone(),
      criticalBypass: row?.criticalBypass ?? true,
      routing: (row?.routing as PlanPrefs['routing']) ?? null,
    };
  }

  async get(userId: number): Promise<InteractionPrefDto> {
    return this.toDto(await this.prefs.findOne({ where: { userId } }));
  }

  /**
   * `PUT /me/prefs` (`ROUTE_REQUIRED` for an empty approval / security route). The first save is an INSERT; a concurrent
   * first save (primary key `user_id`) is re-read and the patch applied as an UPDATE of the patched columns only.
   */
  async save(userId: number, body: unknown): Promise<InteractionPrefDto> {
    const patch = parsePrefBody(body, isTimeZone);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.prefs.findOne({ where: { userId } });
      if (row) {
        const changes = changesOf(patch, row.routing);
        if (Object.keys(changes).length > 0) await this.prefs.update({ userId }, changes);
        return this.saved(userId);
      }
      try {
        await this.prefs.insert({ userId, criticalBypass: true, routing: null, inappDisplay: null, timezone: null, quietHoursStart: null, quietHoursEnd: null, ...changesOf(patch, null) });
        return this.saved(userId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new InteractionError('UPSTREAM_UNAVAILABLE');
  }

  private async saved(userId: number): Promise<InteractionPrefDto> {
    const dto = this.toDto(await this.prefs.findOne({ where: { userId } }));
    this.realtime.publish(userId, { type: 'channels.changed', data: { prefs: '1' } });
    return dto;
  }

  async forget(userId: number): Promise<void> {
    await this.prefs.delete({ userId });
  }

  private toDto(row: InteractionUserPrefEntity | null): InteractionPrefDto {
    const routing = (row?.routing ?? {}) as Partial<Record<InteractionCategory, string[] | null>>;
    const inappDisplay = row?.inappDisplay === 'toast' || row?.inappDisplay === 'browser' ? row.inappDisplay : null;
    return {
      quietHours: row?.quietHoursStart && row.quietHoursEnd ? { start: row.quietHoursStart, end: row.quietHoursEnd } : null,
      timezone: row?.timezone && isTimeZone(row.timezone) ? row.timezone : this.config.defaultTimezone(),
      criticalBypass: row?.criticalBypass ?? true,
      routing: { info: routing.info ?? null, approval: routing.approval ?? null, security: routing.security ?? null },
      inappDisplay,
      effectiveInappDisplay: inappDisplay ?? this.config.inappDisplayDefault(),
    };
  }
}

/** The columns a patch changes (`routing` merged per category into the current one). */
function changesOf(patch: PrefPatch, currentRouting: InteractionUserPrefEntity['routing']): Partial<InteractionUserPrefEntity> {
  const changes: Partial<InteractionUserPrefEntity> = {};
  if (patch.quietHours !== undefined) {
    changes.quietHoursStart = patch.quietHours?.start ?? null;
    changes.quietHoursEnd = patch.quietHours?.end ?? null;
  }
  if (patch.timezone !== undefined) changes.timezone = patch.timezone;
  if (patch.criticalBypass !== undefined) changes.criticalBypass = patch.criticalBypass;
  if (patch.routing !== undefined) changes.routing = { ...(currentRouting ?? {}), ...patch.routing };
  if (patch.inappDisplay !== undefined) changes.inappDisplay = patch.inappDisplay;
  return changes;
}
