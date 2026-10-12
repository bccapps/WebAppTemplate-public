/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { HttpResult } from '../core/http/HttpResult';
import { httpService } from '../core/http/HttpService';
import { configurationService } from './ConfigurationService';

export type ThemeDto = {
  id: number;
  name: string;
  code: string;
  description: string | null;
  active: boolean;
  isDefault: boolean;
  hasCss: boolean;
  createdAt: string;
  updatedAt: string;
};

class ThemeService {
  private baseUrl(): string {
    return configurationService.getApiUrl();
  }

  listActive(): HttpResult {
    return httpService.get(this.baseUrl() + '/themes/active');
  }

  getCss(code: string): Promise<string> {
    // Direct fetch (not through httpService) since we want raw text, not JSON
    return fetch(this.baseUrl() + '/themes/' + code + '/css').then((r) =>
      r.ok ? r.text() : '',
    );
  }

  adminList(): HttpResult {
    return httpService.get(this.baseUrl() + '/admin/themes');
  }

  adminCreate(name: string, description: string): HttpResult {
    return httpService.post(this.baseUrl() + '/admin/themes', {
      name,
      description,
    });
  }

  adminActivate(id: number): HttpResult {
    return httpService.put(this.baseUrl() + '/admin/themes/' + id + '/activate', {});
  }

  adminDeactivate(id: number): HttpResult {
    return httpService.put(this.baseUrl() + '/admin/themes/' + id + '/deactivate', {});
  }

  adminGet(id: number): HttpResult {
    return httpService.get(this.baseUrl() + '/admin/themes/' + id);
  }

  adminUpdateCss(id: number, css: string): HttpResult {
    return httpService.put(this.baseUrl() + '/admin/themes/' + id + '/css', { css });
  }

  adminDelete(id: number): HttpResult {
    return httpService.delete(this.baseUrl() + '/admin/themes/' + id);
  }
}

export const themeService = new ThemeService();
