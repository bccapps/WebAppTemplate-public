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
import { appSession } from '../core/session/AppSession';
import { Configuration } from '@/config/config';

const DEFAULT_API_URL: string = (import.meta as any).env?.VITE_API_URL || '/api/v1';

export class ConfigurationService {
  public preloadKey = 'ConfigurationService';
  /**
   * Guards against re-fetching `/configurations` when `init()` is called more
   * than once — e.g. `main.tsx`'s `RootGate` loads it to decide whether to show
   * the waitlist landing page, then `AppPreloaderGate` loads it again once
   * `<App/>` mounts (PERFORMANCE_PLAN.md §1.4). Set once the first load has
   * applied its data to AppSession.
   */
  private loaded = false;
  /** Shared in-flight promise — a concurrent `init()` call while the first
   *  fetch is still pending piggybacks on it instead of firing a second
   *  `GET /configurations`. */
  private pendingInit: Promise<void> | null = null;
  /**
   * get configuration of app
   * @returns
   */
  getConfiguration(): HttpResult {
    let ret: HttpResult;
    if (Configuration['configurationType'] == 'local') {
      ret = new HttpResult();
      setTimeout(() => {
        if (ret != null && ret.thenCb) ret.thenCb(Configuration);
      }, 0);
    } else {
      ret = httpService.get(DEFAULT_API_URL + '/configurations');
    }
    return ret;
  }

  init(apiUrl: string, callback: () => void): void {
    if (this.loaded) {
      callback?.();
      return;
    }
    if (!this.pendingInit) {
      this.pendingInit = new Promise<void>((resolve) => {
        this.getConfiguration().then((configdata) => {
          if (Configuration['configurationType'] == 'local') {
            appSession.set('config', configdata);
            const configjson = appSession.get('configjson');
            if (typeof configjson === 'undefined' || configjson == null) {
              const configjson: any[] = [];
              for (const elem in configdata) {
                configjson.push({ name: elem, value: configdata[elem] });
              }
              appSession.set('configjson', configjson);
            }
          } else {
            appSession.set('configjson', configdata);
            const existing = appSession.get('config') ?? {};
            const merged: { [id: string]: any } = { ...existing };
            for (const elem of configdata) {
              merged[elem['name']] = elem['value'];
            }
            appSession.set('config', merged);
            this.registerRemoteApiTokens(merged);
          }
          this.loaded = true;
          resolve();
        });
      });
    }
    this.pendingInit.then(() => callback?.());
  }

  /** True when the module is served by a remote API (an absolute `api_url_<moduleId>`), not this app's own backend. */
  isRemoteModule(moduleId: string): boolean {
    return this.getApiUrl(moduleId) !== DEFAULT_API_URL;
  }

  getApiUrl(moduleId?: string): string {
    if (!moduleId) return DEFAULT_API_URL;
    let fromConfig = this.get('api_url_' + moduleId);
    // Only honour absolute remote URLs — relative paths (e.g. /api/v1 seeded for local deployments)
    // must fall through to DEFAULT_API_URL so Cloudflare Pages deployments use the correct baked-in URL.
    if (fromConfig && typeof fromConfig === 'string' && (fromConfig.startsWith('https://') || fromConfig.startsWith('http://'))) {
      // Normalize bare origins to include /api/v1
      if (!fromConfig.includes('/api/')) {
        fromConfig = fromConfig.replace(/\/$/, '') + '/api/v1';
      }
      return fromConfig;
    }
    return DEFAULT_API_URL;
  }

  private registerRemoteApiTokens(config: Record<string, any>): void {
    const techToken = (import.meta as any).env?.VITE_TECH_TOKEN as string | undefined;
    if (!techToken) return;
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith('api_url_') && typeof value === 'string' && value.startsWith('https://')) {
        httpService.registerApiToken(value, techToken);
      }
    }
  }

  /**
   * get a configuration variable value
   * @param
   */
  get(name: string): any {
    let config = appSession.get('config');
    if (!config) {
      config = Configuration;
    }
    if (config && name in config) {
      return this.parseValue(config[name]);
    }
    if (Configuration && name in Configuration) {
      return this.parseValue(Configuration[name]);
    }
    return '';
  }
  /**
   * set a configuration variable value
   * @param
   */
  set(name: string, value: any): void {
    console.log('Setting configuration variable: ', name, value);
    const config = appSession.get('config') ?? {};
    config[name] = value;
    appSession.set('config', config);
  }

  private parseValue(value: any): any {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    if (trimmed.toLowerCase() === 'null') return null;
    if (trimmed.toLowerCase() === 'undefined') return undefined;
    const num = Number(trimmed);
    if (!Number.isNaN(num) && trimmed !== '') return num;
    return value;
  }

  private normalizeEnvKey(moduleId: string): string {
    return moduleId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  }
}

export const configurationService = new ConfigurationService();
