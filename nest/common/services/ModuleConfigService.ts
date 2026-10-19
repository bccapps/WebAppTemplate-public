/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModuleConfigRegistry } from './ModuleConfigRegistry';
import { ModuleConfigSeederService } from './ModuleConfigSeederService';
import { ConfigurationService } from './ConfigurationService';
import { CryptService } from './CryptService';
import { FunctionalException } from '../exceptions/FunctionalException';
import { validateConfigFieldValue } from '../utils/configValueValidation';
import {
  ModuleConfigSchema,
  ModuleConfigWithValues,
  ConfigFieldSchema,
} from '../types/ModuleConfigSchema';

const CRYPT_NAMESPACE = 'module_config';

/**
 * Boolean field value → stored string. Some screens send booleans as strings ("false"), which a plain truthiness test
 * turned into "true" (a non-empty string is truthy): the string forms are parsed explicitly.
 */
export function toBooleanString(value: unknown): 'true' | 'false' {
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()) ? 'true' : 'false';
  return value ? 'true' : 'false';
}

@Injectable()
export class ModuleConfigService {
  private readonly logger = new Logger(ModuleConfigService.name);

  constructor(
    private readonly registry: ModuleConfigRegistry,
    private readonly seederService: ModuleConfigSeederService,
    private readonly configService: ConfigurationService,
    private readonly cryptService: CryptService,
  ) {}

  register(schema: ModuleConfigSchema): void {
    this.registry.register(schema);
    this.seederService.seedSchema(schema).catch((err) => {
      this.logger.error(`Failed to seed config for module "${schema.moduleId}": ${err.message}`);
    });
  }

  /**
   * Get a config value, automatically decrypting if the field is of type 'secret'.
   */
  getDecryptedValue(key: string): any {
    const raw = this.configService.get(key);
    if (raw === undefined || raw === null) return raw;
    const field = this.findFieldByKey(key);
    if (field) {
      return this.parseValue(raw, field);
    }
    return raw;
  }

  /**
   * Resolves a module-config key the same way getModuleConfigWithValues does for the admin UI:
   * falls back to the schema's declared defaultValue when no DB row is seeded yet (or the
   * in-memory ConfigurationService cache hasn't loaded it), instead of returning undefined.
   * Used by callers that must never disagree with what the config admin screen displays for the
   * same key — e.g. the data-ingestion prerequisite check (see incident: a still-empty cache right
   * after a backend restart made every prerequisite look unsatisfied even though the admin UI,
   * reading through this same fallback, correctly showed the seeded/default values).
   * Secrets are returned raw (ciphertext or undefined) — never decrypted, never default-backed,
   * since callers only ever check presence (hasValue), not the value itself.
   */
  getResolvedValue(key: string): any {
    const raw = this.configService.get(key);
    const field = this.findFieldByKey(key);
    if (!field || field.type === 'secret') return raw;
    return raw !== undefined ? this.parseValue(raw, field) : field.defaultValue;
  }

  private findFieldByKey(key: string): ConfigFieldSchema | undefined {
    for (const schema of this.registry.getAllSchemas()) {
      const field = schema.fields.find((f) => f.key === key);
      if (field) return field;
    }
    return undefined;
  }

  getAllSchemas(): ModuleConfigSchema[] {
    return this.registry.getAllSchemas();
  }

  getSchema(moduleId: string): ModuleConfigSchema | undefined {
    return this.registry.getSchema(moduleId);
  }

  async getModuleConfigWithValues(moduleId: string): Promise<ModuleConfigWithValues | null> {
    const schema = this.registry.getSchema(moduleId);
    if (!schema) return null;

    const currentValues: Record<string, any> = {};
    const secretsIsSet: Record<string, boolean> = {};
    for (const field of schema.fields) {
      const raw = this.configService.get(field.key);
      if (field.type === 'secret') {
        // Never expose decrypted secret values — return null + isSet flag
        currentValues[field.key] = null;
        secretsIsSet[field.key] = raw != null && String(raw).length > 0;
      } else {
        currentValues[field.key] = raw !== undefined ? this.parseValue(raw, field) : field.defaultValue;
      }
    }

    return {
      ...schema,
      currentValues,
      secretsIsSet,
    };
  }

  /**
   * Decrypt and return a single secret field's value, scoped to a registered module.
   * Returns null if the module/field doesn't exist or the field isn't of type 'secret'.
   */
  getDecryptedSecretValue(moduleId: string, key: string): string | null {
    const schema = this.registry.getSchema(moduleId);
    const field = schema?.fields.find((f) => f.key === key);
    if (!field || field.type !== 'secret') return null;

    const raw = this.configService.get(key);
    if (raw === undefined || raw === null || raw === '') return '';
    return this.parseValue(raw, field);
  }

  async getAllModuleConfigsWithValues(): Promise<ModuleConfigWithValues[]> {
    const schemas = this.registry.getAllSchemas();
    const results: ModuleConfigWithValues[] = [];

    for (const schema of schemas) {
      const withValues = await this.getModuleConfigWithValues(schema.moduleId);
      if (withValues) {
        results.push(withValues);
      }
    }

    return results;
  }

  async updateModuleConfig(moduleId: string, values: Record<string, any>): Promise<ModuleConfigWithValues | null> {
    const schema = this.registry.getSchema(moduleId);
    if (!schema) return null;

    // Fresh enough cache (reloaded when older than 5 s): "changed" is judged against what is really stored.
    await this.configService.getConfiguration();
    // Unknown keys are ignored; the whole payload is validated before anything is written.
    const dtos = Object.entries(values ?? {}).flatMap(([key, value]) => {
      const field = schema.fields.find((f) => f.key === key);
      if (!field) return [];
      // Skip secret fields where the value is null/empty — preserves existing stored secret
      if (field.type === 'secret' && !(value != null && String(value).length > 0)) return [];
      const serialized = this.serializeValue(value, field);
      this.assertValidChange(field, value, serialized);
      return [{ name: key, value: serialized, description: field.description ?? '' }];
    });

    await this.configService.updateAll(dtos);

    return this.getModuleConfigWithValues(moduleId);
  }

  /**
   * Refuses a CHANGED value that does not fit its field. A value serializing to what is already stored is accepted
   * untouched (screens resend every field, and stored values may predate the schema). Secrets are always a change
   * (their ciphertext is never comparable). Never puts the submitted value in the error: it may be a secret.
   */
  private assertValidChange(field: ConfigFieldSchema, value: unknown, serialized: string): void {
    // Booleans are always validated: their serialization collapses any junk string to "false", which could then match
    // the stored value and let an invalid submission through as "unchanged".
    if (field.type !== 'secret' && field.type !== 'boolean') {
      const stored = this.configService.get(field.key);
      if (stored !== undefined && stored !== null && String(stored) === serialized) return;
    }
    const issue = validateConfigFieldValue(field, value);
    if (issue) throw new FunctionalException(issue.code, `Invalid value for '${field.key}': ${issue.reason}`);
  }

  private parseValue(value: any, field: ConfigFieldSchema): any {
    if (value === null || value === undefined) return field.defaultValue;

    let strValue = String(value);

    if (field.type === 'secret' && strValue) {
      try {
        strValue = this.cryptService.decryptFromStorage<string>(strValue, CRYPT_NAMESPACE);
      } catch {
        // Legacy plaintext value — return as-is
        this.logger.debug(`Field ${field.key}: not encrypted yet, returning plaintext`);
      }
      return strValue;
    }

    switch (field.type) {
      case 'boolean':
        return strValue === 'true' || strValue === '1';
      case 'number':
        const num = Number(strValue);
        return Number.isFinite(num) ? num : field.defaultValue;
      case 'json':
        try {
          return JSON.parse(strValue);
        } catch {
          return field.defaultValue;
        }
      case 'multiselect':
        if (Array.isArray(value)) return value;
        try {
          const parsed = JSON.parse(strValue);
          return Array.isArray(parsed) ? parsed : [strValue];
        } catch {
          return strValue.split(',').map((s) => s.trim()).filter(Boolean);
        }
      default:
        return strValue;
    }
  }

  private serializeValue(value: any, field?: ConfigFieldSchema): string {
    if (value === null || value === undefined) return '';

    if (!field) return String(value);

    switch (field.type) {
      case 'secret': {
        const strVal = String(value);
        if (!strVal) return '';
        return this.cryptService.encryptForStorage(strVal, CRYPT_NAMESPACE);
      }
      case 'boolean':
        return toBooleanString(value);
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
