/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export const FALLBACK_TIMEZONES = [
  'UTC',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Indian/Reunion'
];

export const getSupportedTimezones = () => {
  const intlWithSupport = Intl as typeof Intl & {
    supportedValuesOf?: (input: 'timeZone') => string[];
  };
  if (typeof intlWithSupport.supportedValuesOf === 'function') {
    try {
      return Array.from(new Set(intlWithSupport.supportedValuesOf('timeZone')));
    } catch (error) {
      console.warn('Intl.supportedValuesOf failed, using fallback timezones', error);
      return FALLBACK_TIMEZONES;
    }
  }
  return FALLBACK_TIMEZONES;
};
