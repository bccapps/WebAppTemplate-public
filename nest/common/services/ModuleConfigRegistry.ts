/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';

@Injectable()
export class ModuleConfigRegistry {
  private schemas: Map<string, ModuleConfigSchema> = new Map();

  register(schema: ModuleConfigSchema): void {
    const existing = this.schemas.get(schema.moduleId);
    if (existing) {
      // Merge fields from the new schema into the existing one (avoid duplicates by key)
      const existingKeys = new Set(existing.fields.map((f) => f.key));
      const newFields = schema.fields.filter((f) => !existingKeys.has(f.key));
      existing.fields.push(...newFields);
    } else {
      this.schemas.set(schema.moduleId, { ...schema });
    }
  }

  unregister(moduleId: string): void {
    this.schemas.delete(moduleId);
  }

  getSchema(moduleId: string): ModuleConfigSchema | undefined {
    return this.schemas.get(moduleId);
  }

  getAllSchemas(): ModuleConfigSchema[] {
    return Array.from(this.schemas.values());
  }

  getModuleIds(): string[] {
    return Array.from(this.schemas.keys());
  }

  hasModule(moduleId: string): boolean {
    return this.schemas.has(moduleId);
  }
}
