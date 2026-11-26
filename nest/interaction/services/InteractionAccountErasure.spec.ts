/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { getMetadataArgsStorage } from 'typeorm';
import { ACCOUNT_ERASURE_PARTICIPANT, ACCOUNT_PURGE_PARTICIPANT } from '../../common/types/ExtensionPoints';
import { INTERACTION_ENTITIES } from '../interactionEntities';
import { INTERACTION_PURGE_COLUMN_RULES, InteractionAccountErasure } from './InteractionAccountErasure';

/** `<table>.<column>` → the column's options, for every entity of the module. */
function columnsOfTheModule(): Map<string, { nullable?: boolean; type?: unknown }> {
  const storage = getMetadataArgsStorage();
  const columns = new Map<string, { nullable?: boolean; type?: unknown }>();
  for (const entity of INTERACTION_ENTITIES) {
    const table = storage.tables.find((t) => t.target === entity)?.name;
    for (const column of storage.columns.filter((c) => c.target === entity)) {
      columns.set(`${table}.${column.options.name ?? column.propertyName}`, { nullable: column.options.nullable, type: column.options.type });
    }
  }
  return columns;
}

describe('InteractionAccountErasure — the account erasure and purge participant of the module', () => {
  it('is found by `user` both as an erasure participant and as a purge participant (rules only)', () => {
    expect(Reflect.getMetadata(ACCOUNT_ERASURE_PARTICIPANT, InteractionAccountErasure)).toBe(true);
    expect(Reflect.getMetadata(ACCOUNT_PURGE_PARTICIPANT, InteractionAccountErasure)).toBe(true);
    const participant = new InteractionAccountErasure({} as never);
    expect(participant.purgeKey).toBe('interaction');
    expect(participant.purgeColumnRules).toBe(INTERACTION_PURGE_COLUMN_RULES);
  });

  it('its rules name real nullable integer columns of the module (the safety net would null them), deleted instead', () => {
    const columns = columnsOfTheModule();
    expect(INTERACTION_PURGE_COLUMN_RULES.map((rule) => `${rule.table}.${rule.column}:${rule.action}`)).toEqual([
      'interaction_link_code.user_id:delete',
      'interaction_telegram_link.user_id:delete',
    ]);
    for (const rule of INTERACTION_PURGE_COLUMN_RULES) {
      expect(columns.get(`${rule.table}.${rule.column}`)).toEqual({ nullable: true, type: 'integer' });
    }
  });
});
