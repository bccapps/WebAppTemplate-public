/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import EventObject from '../eventObject/EventObject';

export default class Session extends EventObject {
  map: any = {};

  constructor() {
    super();
  }

  /**
   * set an object in session with specified key
   * @param key key
   * @param value object
   */
  set = (key: string, value: any) => {
    this.map[key] = value;
    try {
      const storageKey = `session:${key}`;
      if (value === null || value === undefined) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, JSON.stringify(value));
      }
    } catch (e) {
      // ignore storage errors
    }
    this.dispatchEvent(key, { key, value });
  };

  /**
   * return the object of specified key or null if doesnt exist
   * @param key wanted key
   * @returns
   */
  get = (key: string) => {
    if (this.has(key)) return this.map[key];
    try {
      // Primary: namespaced session key
      const storageKey = `session:${key}`;
      let raw = localStorage.getItem(storageKey);
      // Migration: fallback to plain key if exists (e.g., legacy 'user')
      if (raw == null) {
        raw = localStorage.getItem(key);
      }
      if (raw != null) {
        const parsed = JSON.parse(raw);
        this.map[key] = parsed;
        return parsed;
      }
    } catch (e) {
      // ignore parse/storage errors
    }
    return null;
  };

  /**
   * force update of the object of specified key by setting it to itself
   * @param key wanted key
   * @returns
   */
  force = (key: string) => {
    return this.has(key) ? this.set(key, this.map[key]) : null;
  };

  /**
   * return true if the object exist in the session , false otherwise
   * @param key wanted key
   * @returns
   */
  has = (key: string) => {
    return Object.prototype.hasOwnProperty.call(this.map, key);
  };
}
