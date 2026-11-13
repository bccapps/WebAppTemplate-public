/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { REDACTED_SEGMENT, SECRET_SEGMENT_PREFIXES, redactPath } from '../utils/redactPath';
import {
  FAKE_SECRET_MARKERS,
  PREFIXED_IDENTIFIERS,
  SECRET_FORMATS,
  SECRET_FORMAT_PREFIXES,
  URL_SECRET_PREFIXES,
  secretFormatOf,
  secretFormatPattern,
  validateSecretFormatRegistry,
} from './secretFormats';
import { leaksSecret, randomSecretBody, secretFormatFixtures } from './secretFixtures.testkit';
import { sanitizeTraceFields, sanitizeTraceString } from './traceSanitizer';

const HIDDEN = /^hmac:[0-9a-f]{16};len=\d+$/;

/** Shannon entropy in bits per character: the measure gitleaks compares with a rule's `entropy`. */
function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / value.length) * Math.log2(n / value.length);
  return h;
}

describe('secret-formats.json', () => {
  it('lists every app prefix of the plan once, each id once', () => {
    expect(new Set(SECRET_FORMATS.map((f) => f.id)).size).toBe(SECRET_FORMATS.length);
    expect([...SECRET_FORMAT_PREFIXES].sort()).toEqual(
      ['ac_live_', 'acs_', 'ahe_', 'ahf_', 'ahi_', 'ahr_', 'ctd_', 'ffg_', 'llmpt_', 'mst_', 'pwk_', 'smx_', 'sup_', 'tk_', 'tkp_', 'whsec_'].sort(),
    );
    expect(SECRET_FORMATS.filter((f) => f.oauth).map((f) => f.prefix).sort()).toEqual(['ac_live_', 'ctd_', 'ffg_', 'mst_', 'pwk_', 'tk_'].sort());
    // AgentHub mints 32 base62 only (ApiKeyService.randomBase62): no legacy wide format in the registry.
    expect(SECRET_FORMATS.find((f) => f.prefix === 'ac_live_')).toMatchObject({ charset: 'base62', length: 32, leftBoundary: true });
  });

  it.each(secretFormatFixtures().map((f) => [`${f.format.id} (${f.kind})`, f] as const))('recognizes a random %s', (_label, fixture) => {
    expect(secretFormatOf(fixture.value)).toEqual({ format: fixture.format, kind: fixture.kind });
  });

  it('compiles each pattern once (secretFormatOf runs on hot paths)', () => {
    const format = SECRET_FORMATS[0];
    expect(secretFormatPattern(format)).toBe(secretFormatPattern(format));
    expect(secretFormatPattern(format, 'oauth')).toBe(secretFormatPattern(format, 'oauth'));
  });

  it('keeps a key and an OAuth token of the same prefix disjoint by length', () => {
    for (const format of SECRET_FORMATS.filter((f) => f.oauth)) {
      const token = `${format.prefix}at_${randomSecretBody('base64url', 43)}`;
      expect(secretFormatPattern(format).test(token)).toBe(false);
      expect(secretFormatPattern(format, 'oauth').test(token)).toBe(true);
    }
  });

  it('sets every entropy threshold under what random secrets reach, above placeholders (2,000 draws per format)', () => {
    for (const format of SECRET_FORMATS.filter((f) => f.minEntropy > 0)) {
      const length = format.length ?? 32;
      let lowest = Infinity;
      for (let i = 0; i < 2000; i += 1) lowest = Math.min(lowest, shannon(`${format.prefix}${randomSecretBody(format.charset, length)}`));
      expect(lowest).toBeGreaterThan(format.minEntropy + 0.2);
      expect(shannon(`${format.prefix}${'x'.repeat(length)}`)).toBeLessThan(format.minEntropy);
    }
  });

  it('does not list a public identifier (cmp_, dcr_) as a secret', () => {
    for (const identifier of PREFIXED_IDENTIFIERS) {
      expect(SECRET_FORMAT_PREFIXES).not.toContain(identifier.prefix);
      expect(secretFormatOf(`${identifier.prefix}${randomSecretBody('base64url', 32)}`)).toBeNull();
    }
  });

  it('refuses a malformed registry at load', () => {
    const base = { charsets: { base64url: 'A-Za-z0-9_-', base62: 'A-Za-z0-9', hex: '0-9a-f' }, fakeMarkers: [], oauth: { markers: [], charset: 'base64url', length: 43, minEntropy: 0 }, identifiers: [] } as const;
    const ok = { id: 'a', app: 'x', prefix: 'ab_', charset: 'hex', length: 4, minEntropy: 0, oauth: false, inUrl: false, description: '', source: '' } as const;
    expect(() => validateSecretFormatRegistry({ ...base, formats: [ok] })).not.toThrow();
    expect(() => validateSecretFormatRegistry({ ...base, formats: [ok, ok] })).toThrow(/duplicate id/);
    expect(() => validateSecretFormatRegistry({ ...base, formats: [{ ...ok, prefix: 'AB_' }] })).toThrow(/prefix/);
    expect(() => validateSecretFormatRegistry({ ...base, formats: [{ ...ok, charset: 'nope' as 'hex' }] })).toThrow(/unknown charset/);
    expect(() => validateSecretFormatRegistry({ ...base, formats: [{ ...ok, length: undefined }] })).toThrow(/length/);
  });
});

describe('runtime consumers of the registry', () => {
  it.each(secretFormatFixtures().map((f) => [`${f.format.id} (${f.kind})`, f.value] as const))('the trace sanitizer hides a random %s', (_label, value) => {
    for (const text of [value, `rejected ${value} (retry)`, `"${value}"`]) expect(sanitizeTraceString(text)).toMatch(HIDDEN);
    expect(leaksSecret(JSON.stringify(sanitizeTraceFields({ detail: `got ${value}` }, '*')), value)).toBe(false);
  });

  it.each([...SECRET_FORMAT_PREFIXES])('the trace sanitizer hides %s + 10 plain letters (the prefix alone is enough)', (prefix) => {
    expect(sanitizeTraceString(`${prefix}abcdefghij`)).toMatch(HIDDEN);
  });

  it('still hides a FAKE-marked value at run time (the marker only quiets the repository scanner)', () => {
    for (const marker of FAKE_SECRET_MARKERS) expect(sanitizeTraceString(`tk_${marker}${randomSecretBody('base64url', 43 - marker.length)}`)).toMatch(HIDDEN);
  });

  it('redacts the URL tokens of the registry in a path, and keeps the third-party list of redactPath', () => {
    expect([...URL_SECRET_PREFIXES]).toEqual(['acs_', 'ahe_', 'ahf_', 'ahi_', 'ahr_']);
    expect([...SECRET_SEGMENT_PREFIXES]).toEqual([
      'acs_', 'ahe_', 'ahf_', 'ahi_', 'ahr_', 'sk_', 'rk_', 'whsec_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xkeysib-',
    ]);
    for (const format of SECRET_FORMATS.filter((f) => f.inUrl)) {
      const token = `${format.prefix}${randomSecretBody(format.charset, format.length ?? 32)}`;
      expect(redactPath(`/api/v1/agenthub/share-info/${token}?x=1`)).toBe(`/api/v1/agenthub/share-info/${REDACTED_SEGMENT}`);
    }
  });
});
