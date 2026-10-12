/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { httpService } from '../core/http/HttpService';
import { configurationService } from './ConfigurationService';
import type { ModuleConfigSchema, ModuleConfigWithValues } from '../types/ModuleConfigSchema';

class ModuleConfigService {
  private buildEndpoint(path: string = ''): string {
    return `${configurationService.getApiUrl()}/admin/module-configs${path}`;
  }

  async getSchemas(): Promise<ModuleConfigSchema[]> {
    return new Promise((resolve, reject) => {
      httpService
        .get(this.buildEndpoint('/schemas'))
        .then((data) => resolve(data ?? []))
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async getAllWithValues(): Promise<ModuleConfigWithValues[]> {
    return new Promise((resolve, reject) => {
      httpService
        .get(this.buildEndpoint())
        .then((data) => resolve(data ?? []))
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async getModuleConfig(moduleId: string): Promise<ModuleConfigWithValues | null> {
    return new Promise((resolve, reject) => {
      httpService
        .get(this.buildEndpoint(`/${moduleId}`))
        .then((data) => resolve(data ?? null))
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async getSecretValue(moduleId: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      httpService
        .get(this.buildEndpoint(`/${moduleId}/secret/${key}`))
        .then((data) => resolve(data?.value ?? ''))
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }

  async updateModuleConfig(moduleId: string, values: Record<string, any>): Promise<ModuleConfigWithValues | null> {
    return new Promise((resolve, reject) => {
      httpService
        .put(this.buildEndpoint(`/${moduleId}`), values)
        .then((data) => resolve(data ?? null))
        .fail(reject)
        .error(reject)
        .notAuthorized(reject);
    });
  }
}

export const moduleConfigService = new ModuleConfigService();
