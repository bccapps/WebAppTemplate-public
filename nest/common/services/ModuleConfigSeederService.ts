/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import ConfigurationEntity from '../entities/ConfigurationEntity';
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';
import { defaultConfigEntries } from 'src/config/defaultConfig';
import { insertConfigIfAbsent } from '../utils/insertConfigIfAbsent';
import { ConfigurationService } from './ConfigurationService';

@Injectable()
export class ModuleConfigSeederService {
  private readonly logger = new Logger(ModuleConfigSeederService.name);

  constructor(
    @InjectRepository(ConfigurationEntity)
    private readonly configRepo: Repository<ConfigurationEntity>,
    /** Reloaded after an insert, so a seeded key is visible to `get()` at once (never read as missing). */
    @Optional() private readonly configuration?: ConfigurationService,
  ) {}

  async seedSchema(schema: ModuleConfigSchema): Promise<void> {
    // One idempotent insert for the whole schema: rows already stored (or stored meanwhile by another seeder) are kept.
    // Precedence: on a fresh database the app's defaultConfig.ts wins over a module schema default (the app is more
    // specific). Keys listed there are owned by ConfigSeederService and skipped here, so the result never depends on
    // which seeder runs first.
    const appKeys = new Set(defaultConfigEntries.map((entry) => entry.name));
    const rows = schema.fields
      .filter((field) => field.defaultValue !== undefined && !appKeys.has(field.key))
      .map((field) => ({
        name: field.key,
        value: this.serializeValue(field.defaultValue, field.type),
        description: field.description ?? '',
      }));
    const seededCount = await insertConfigIfAbsent(this.configRepo, rows);
    if (seededCount > 0) {
      this.logger.log(`Seeded ${seededCount} config entries for module "${schema.moduleId}"`);
    }
    // Reload whenever a key of the schema is still missing from the cache, even with nothing inserted HERE: another
    // process (worker, replica) or a concurrent seeder may have written it after this cache was loaded.
    if (rows.some(({ name }) => this.configuration?.get(name) === undefined)) await this.configuration?.refresh();
  }

  private serializeValue(value: any, type: string): string {
    if (value === null || value === undefined) return '';
    switch (type) {
      case 'boolean':
        return value ? 'true' : 'false';
      case 'number':
        return String(value);
      case 'json':
      case 'multiselect':
        return JSON.stringify(value);
      default:
        return String(value);
    }
  }
}
