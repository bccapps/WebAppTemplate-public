/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import EventObject from '../eventObject/EventObject';

/** JSON of `value` when that JSON fully describes it (primitive, null, plain object or array), else `null`. */
const comparableJson = (value: unknown): string | null => {
  if (value === undefined) return null;
  const isPlain = value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) === Object.prototype;
  if (!isPlain) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

export interface SessionSetOptions {
  /** Emit the change event even when the value is unchanged (see `force`). */
  force?: boolean;
}

export default class Session extends EventObject {
  map: any = {};
  /** JSON of the last value written by `set()` per key — what "unchanged" is compared against. */
  private lastJson: Record<string, string> = {};

  constructor() {
    super();
  }

  /**
   * set an object in session with specified key
   *
   * Listeners are not notified when the new value serializes exactly like the last one written
   * for this key (e.g. the same profile re-set after a refresh): every subscriber
   * (`useSessionKeys`, services) would otherwise re-render/re-run for nothing. The comparison is
   * on the JSON captured at the previous `set()`, so an object mutated in place and set again
   * still notifies. Values JSON cannot describe (class instances, Map, Set…) always notify.
   * Pass `{ force: true }` (or call `force(key)`) to notify regardless.
   * @param key key
   * @param value object
   */
  set = (key: string, value: any, options: SessionSetOptions = {}) => {
    const json = comparableJson(value);
    const unchanged = json !== null && this.has(key) && this.lastJson[key] === json;
    this.map[key] = value;
    if (json === null) delete this.lastJson[key];
    else this.lastJson[key] = json;
    if (unchanged && !options.force) return;
    try {
      const storageKey = `session:${key}`;
      if (value === null || value === undefined) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, json ?? JSON.stringify(value));
      }
    } catch {
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
    } catch {
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
    return this.has(key) ? this.set(key, this.map[key], { force: true }) : null;
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
