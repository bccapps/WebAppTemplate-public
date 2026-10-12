/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { uuid } from '../uuid/Uuid';

export default class EventObject {
  listeners: any;
  constructor() {
    this.listeners = {};
  }

  /**
   * add event listener
   * @param type
   * @param func
   * @returns
   */
  addEventListener = (type: string, func: any) => {
    if (!Object.prototype.hasOwnProperty.call(this.listeners, type)) {
      this.listeners[type] = [];
    }
    const id = uuid.randomUuid();
    this.listeners[type].push({ id, func });
    return id;
  };

  /**
   * remove event listener
   * @param id uuid
   */
  removeEventListerner = (id: string | null) => {
    if (id == null) return;
    const treat = (key: string) => {
      const arr = this.listeners[key];
      if (arr && arr.length > 0) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (id == arr[i].id) {
            arr.splice(i, 1);
            return;
          }
        }
      }
    };
    Object.keys(this.listeners).map(treat);
  };

  /**
   * dispatch event
   * @param type
   * @param event
   */
  dispatchEvent = (type: string, event: any) => {
    const arr = this.listeners[type];
    const funcs: any[] = [];
    if (arr && arr.length > 0) {
      for (let i = arr.length - 1; i >= 0; i--) {
        funcs.push(arr[i].func);
      }
    }

    for (let i = 0; i < funcs.length; i++) {
      try {
        funcs[i](event);
      } catch (err: any) {
        console.warn(err.message);
      }
    }
  };
}
