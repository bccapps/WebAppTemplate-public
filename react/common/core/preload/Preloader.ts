/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import EventObject from '../eventObject/EventObject';

export default class Preloader extends EventObject {
  services: any[] = [];
  services_names: string[] = [];
  loaded_items: any = {};

  constructor() {
    super();
  }


  nb_loaded(): number {
    let nb = 0;
    for (const name of this.services_names) {
      if (this.loaded_items[name] === true) {
        nb++;
      }
    }
    return nb;
  }

  ready(): boolean {
    // Return true if all services are loaded
    // and false if at least one service is not loaded
    let ready = false;
    const nb_loaded = this.nb_loaded();
    if (nb_loaded > 0 && nb_loaded == this.services_names.length) ready = true;
    //console.log('Ready : ', ready, ' - Nb loaded: ', nb_loaded, '/', this.services_names.length);
    return ready;
    //return this.services_names.every((name: string) => this.loaded_items[name] === true);
  }

  private resolveName(service: any): string {
    return service?.preloadKey || service?.constructor?.name || 'Service';
  }

  add = (service: any) => {
    const serviceName = this.resolveName(service);
    if (this.services_names.includes(serviceName)) {
      //console.log('Service already added, skipping: ', serviceName);
      return;
    }
    //console.log('Adding service: ', serviceName, ' - service number :', this.services.length);

    // ConfigurationService must always be queued before the rest so downstream
    // services can rely on the remote config values it sets up.
    if (serviceName === 'ConfigurationService') {
      this.services.unshift(service);
      this.services_names.unshift(serviceName);
    } else {
      this.services.push(service);
      this.services_names.push(serviceName);
    }

    this.loaded_items[serviceName] = false;
  };

  /**
   * Two waves instead of a fully serial chain (PERFORMANCE_PLAN.md §1.1):
   * `ConfigurationService` alone first — it's the only real dependency, every
   * other service only reads the config values it sets up (API URL, feature
   * flags, …) — then everything else in parallel, since those services are
   * independent of each other. Falls back to loading everything in parallel
   * right away when no `ConfigurationService` is registered.
   *
   * `ready()`/`nb_loaded()` stay correct under concurrent completions: each
   * service's `markLoaded` call is a single synchronous step (JS has no
   * pre-emption), so exactly one call ever observes `nb_loaded` crossing from
   * `n-1` to `n` — the `ready` event still fires exactly once, whichever
   * service happens to finish last.
   */
  load(apiUrl: string): void {
    const servicesToLoad = [...this.services];

    if (servicesToLoad.length === 0) {
      try {
        this.dispatchEvent('ready', {});
      } catch (e) {
        console.error('Preloader: "ready" listener threw', e);
      }
      return;
    }

    const markLoaded = (name: string) => {
      console.log('Service loaded: ', name);
      this.loaded_items[name] = true;
      if (this.ready()) {
        try {
          this.dispatchEvent('ready', {});
        } catch (e) {
          console.error('Preloader: "ready" listener threw', e);
        }
      }
    };

    const startService = (service: any) => {
      const name = this.resolveName(service);
      console.log('Loading service: ', name);
      if (name === 'ConfigurationService') {
        service.init(apiUrl, () => markLoaded(name));
      } else {
        service.init(() => markLoaded(name));
      }
    };

    const configIndex = servicesToLoad.findIndex((s) => this.resolveName(s) === 'ConfigurationService');
    if (configIndex === -1) {
      servicesToLoad.forEach(startService);
      return;
    }

    const configService = servicesToLoad[configIndex];
    const rest = servicesToLoad.filter((_, i) => i !== configIndex);
    const configName = this.resolveName(configService);

    console.log('Loading service: ', configName);
    configService.init(apiUrl, () => {
      markLoaded(configName);
      rest.forEach(startService);
    });
  }

  getLoadLabel(): string {
    let ret = 'Loading';
    if (!this.ready()) {
      this.services_names.forEach(name => {
        if (!this.loaded_items[name]) ret += ' - ' + name;
      });
    }
    return ret;
  }
}
