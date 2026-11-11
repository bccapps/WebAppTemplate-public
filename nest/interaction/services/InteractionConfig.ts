/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { INTERACTION_MODULE_ID, interactionConfigSchema, interactionDefault } from '../interactionConfigSchema';
import { isBotToken } from '../pure/telegramUpdate';

export type TelegramMode = 'off' | 'own' | 'operator' | 'both';

/**
 * Typed reader of `interaction_*` (read at every use: a change in the admin screen applies without a restart). A value
 * out of its range or of the wrong type falls back to the schema's default. Registers the schema at bootstrap.
 */
@Injectable()
export class InteractionConfig implements OnApplicationBootstrap {
  constructor(private readonly moduleConfig: ModuleConfigService) {}

  onApplicationBootstrap(): void {
    this.moduleConfig.register(interactionConfigSchema);
  }

  private raw(key: string): unknown {
    const value = this.moduleConfig.getResolvedValue(key);
    return value === undefined || value === null || value === '' ? interactionDefault(key) : value;
  }

  number(key: string, min: number, max: number): number {
    const value = Number(this.raw(key));
    if (Number.isFinite(value) && value >= min && value <= max) return value;
    return Number(interactionDefault(key));
  }

  string(key: string): string {
    const value = this.raw(key);
    return typeof value === 'string' ? value.trim() : String(interactionDefault(key) ?? '');
  }

  enabledKinds(): string[] {
    const value = this.raw('interaction_enabledKinds');
    const list = Array.isArray(value) ? value : typeof value === 'string' ? parseList(value) : [];
    return [...new Set(list.map((kind) => String(kind).trim()).filter((kind) => kind !== '' && kind !== 'inapp'))];
  }

  inappDisplayDefault(): 'toast' | 'browser' {
    return this.raw('interaction_inappDisplayDefault') === 'browser' ? 'browser' : 'toast';
  }

  defaultTimezone(): string {
    const zone = this.string('interaction_defaultTimezone');
    return isTimeZone(zone) ? zone : 'Europe/Paris';
  }

  telegramMode(): TelegramMode {
    const value = this.raw('interaction_telegramMode');
    return value === 'off' || value === 'operator' || value === 'both' ? value : 'own';
  }

  telegramInbound(): 'poll' | 'webhook' {
    return this.raw('interaction_telegramInbound') === 'webhook' ? 'webhook' : 'poll';
  }

  /** The operator's bot token, decrypted for one call; null when absent or not shaped like a token (fails closed). */
  operatorBotToken(): string | null {
    const value = this.moduleConfig.getDecryptedSecretValue(INTERACTION_MODULE_ID, 'interaction_telegramOperatorBotToken');
    const token = typeof value === 'string' ? value.trim() : '';
    return isBotToken(token) ? token : null;
  }

  providerTimeoutMs(): number {
    return this.number('interaction_providerTimeoutMs', 1000, 60000);
  }
}

/** A multiselect value stored as JSON (`["a","b"]`) or as a comma list. */
function parseList(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* a comma list */
  }
  return value.split(',');
}

/** A time zone `Intl` knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
