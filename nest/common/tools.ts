/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export class Utils {
  static pf(bal: number) {
    let ret = '0';
    if (bal > 0) {
      if (bal < 0.0001 && bal > -0.0001) {
        ret = bal.toFixed(8);
      } else if (bal < 0.01 && bal > -0.01) {
        ret = bal.toFixed(4);
      } else if (bal < 1 && bal > -1) {
        ret = bal.toFixed(3);
      } else if (bal % 1 == 0) {
        ret = bal.toFixed(0);
      } else {
        ret = bal.toFixed(2);
      }
    }
    return ret;
  }

  static customSort2(a: any, b: any, criteria1: string, criteria2: string) {
    return a[criteria1] > b[criteria1]
      ? 1
      : a[criteria1] === b[criteria1]
      ? a[criteria2] > b[criteria2]
        ? 1
        : -1
      : -1;
  }
  static customSort(a: any, b: any, criteria1: string) {
    return a[criteria1] > b[criteria1] ? 1 : -1;
  }

  static getShortDate(date: Date) {
    //console.log('in shortDate : ', date);
    let ret = '';
    if (date && date.getTime() > 0)
      ret =
        date.toLocaleDateString() +
        ' ' +
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ret;
  }

  static BEER = '&#127866;';
  static BEERS = '&#x1f37b;';
  static DEFAULT_DONATION = 2;

  static isMobile() {
    const globalRef = globalThis as typeof globalThis & {
      window?: { matchMedia?: (query: string) => { matches: boolean } };
      navigator?: { userAgent?: string };
    };
    if (typeof globalRef.window === 'undefined') {
      return false;
    }
    const hasCoarsePointer =
      globalRef.window?.matchMedia?.('(pointer:coarse)')?.matches ?? false;
    const ua = globalRef.navigator?.userAgent ?? '';
    const matchesUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|Opera Mini/u.test(ua);
    return Boolean(hasCoarsePointer || matchesUa);
  }

  static capitalize(str: string) {
    return str[0].toUpperCase() + str.slice(1);
  }

  static getPad2(num: number) {
    if (num < 10) {
      return '0' + num;
    }
    return num;
  }

  // Expects a timestamp in ms
  static getDate(ts: number) {
    const date = new Date(ts);
    //console.log( "getDate - TS="+ts);
    //return date.toString();
    return date.toLocaleString();
  }

  static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static hexEncode = (str: string) => {
    let hex, i;
    let result = '';
    for (i = 0; i < str.length; i++) {
      hex = str.charCodeAt(i).toString(16);
      console.log(
        'char=' +
          str.charAt(i) +
          ' - charCode=' +
          str.charCodeAt(i) +
          ' - hex=' +
          hex
      );
      result += ('000' + hex).slice(-4);
    }

    return result;
  };

  static getRandom(min: number, max: number) {
    return Math.round(Math.random() * (max - min) + min);
  }
}
