/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import type { AuthPrincipal } from '../auth';
import { compileTopicPattern, hasAudience, matchesAudience } from './audience';

const user: AuthPrincipal = { id: 7, admin: false, kind: 'user', tenantId: 'c1' };
const admin: AuthPrincipal = { id: 0, admin: true, kind: 'admin-token' };

describe('audience', () => {
  it('reaches nobody without any field', () => {
    expect(hasAudience({})).toBe(false);
    expect(hasAudience(undefined)).toBe(false);
    expect(matchesAudience({}, user)).toBe(false);
    expect(matchesAudience({}, admin)).toBe(false);
  });

  it('matches userId, tenantId, admin and public', () => {
    expect(matchesAudience({ userId: 7 }, user)).toBe(true);
    expect(matchesAudience({ userId: 8 }, user)).toBe(false);
    expect(matchesAudience({ tenantId: 'c1' }, user)).toBe(true);
    expect(matchesAudience({ tenantId: 'c2' }, user)).toBe(false);
    expect(matchesAudience({ admin: true }, admin)).toBe(true);
    expect(matchesAudience({ admin: true }, user)).toBe(false);
    expect(matchesAudience({ public: true }, user)).toBe(true);
  });

  it('requires every present field to match', () => {
    expect(matchesAudience({ userId: 7, tenantId: 'c1' }, user)).toBe(true);
    expect(matchesAudience({ userId: 7, tenantId: 'c2' }, user)).toBe(false);
    expect(matchesAudience({ userId: 7, admin: true }, user)).toBe(false);
  });

  it('compares a numeric tenant id with its string form', () => {
    expect(matchesAudience({ tenantId: 12 }, { ...user, tenantId: '12' })).toBe(true);
  });

  it('compiles topic patterns', () => {
    const match = compileTopicPattern('ocr.document:*');
    expect(match('ocr.document:42')).toEqual({ topic: 'ocr.document:42', key: '42' });
    expect(match('ocr.document:')).toBeNull();
    expect(match('ocr.documents:42')).toBeNull();
    expect(compileTopicPattern('tradingbot.runs')('tradingbot.runs')).toEqual({ topic: 'tradingbot.runs', key: '' });
    expect(compileTopicPattern('a.b')('aXb')).toBeNull();
  });
});
