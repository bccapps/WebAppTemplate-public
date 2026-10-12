/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * "I could not read this" must not be reported as "this was never encrypted".
 *
 * The decryption fallback exists for LEGACY PLAINTEXT values, and for those returning the value
 * unchanged is exactly right. But the same branch also catches ciphertext that fails to
 * authenticate — wrong master key, wrong namespace, corruption — and there returning the value
 * hands a base64 blob to a caller that will use it as a credential. The venue then answers
 * `Signature check failed`, an error that describes the remote and says nothing about the local
 * cause.
 *
 * On 2026-08-13 that exact symptom sent an investigation to Aster, whose key turned out to be
 * perfectly valid; the "18 accesses unreadable" reading was a namespace mistake of my own
 * (the namespace follows the entity PROPERTY name — column `lkey` → property `key`). What made
 * the mistake expensive is that the log said "plaintext fallback" about values that were plainly
 * ciphertext, pointing away from the cause.
 *
 * Same family as the empty-position-list and the empty-order-id confusions: never let "I don't
 * know" render as a confident value.
 */
import { describe, expect, it } from '@jest/globals';
import { STORAGE_PAYLOAD_VERSION } from '../constants/crypt.constants';

/** The shape test as it now runs inside the transformer. */
function looksEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 5 && parts[0] === STORAGE_PAYLOAD_VERSION;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const ciphertext = [STORAGE_PAYLOAD_VERSION, b64('sel'), b64('iv'), b64('tag'), b64('chiffré')].join(':');

describe('a value written by us is recognised as ciphertext', () => {
  it('recognises the canonical five-part payload', () => {
    expect(looksEncrypted(ciphertext)).toBe(true);
  });

  it('does not depend on the segment contents, only on the shape', () => {
    expect(looksEncrypted(`${STORAGE_PAYLOAD_VERSION}:a:b:c:d`)).toBe(true);
  });
});

describe('a legacy plaintext value is not mistaken for ciphertext', () => {
  it.each([
    ['une clé API nue', 'sk_live_' + 'x'.repeat(24)],
    ['une adresse EVM', '0x93b574905a75aD48107d0eDE397ED5BFdcdDB3B7'],
    ['une chaîne vide de séparateurs', 'motdepasse'],
    ['un mot de passe contenant des deux-points', 'a:b'],
  ])('%s reste du plaintext', (_label, value) => {
    expect(looksEncrypted(value)).toBe(false);
  });

  it('rejects a five-part value carrying a different version marker', () => {
    // A future v2 payload read by an old build is not plaintext either, but it is also not
    // something this build can claim to recognise — the version check keeps that honest.
    expect(looksEncrypted('v0:a:b:c:d')).toBe(false);
  });

  it('rejects a value with the right version but the wrong arity', () => {
    expect(looksEncrypted(`${STORAGE_PAYLOAD_VERSION}:a:b:c`)).toBe(false);
    expect(looksEncrypted(`${STORAGE_PAYLOAD_VERSION}:a:b:c:d:e`)).toBe(false);
  });

  it('rejects a plaintext value that merely contains four colons', () => {
    expect(looksEncrypted('a:b:c:d:e')).toBe(false);
  });
});

describe('the two failures are reported under distinct keys', () => {
  /** Mirrors the once-per-process dedup key built in the transformer. */
  const warnKey = (namespace: string, value: string) =>
    `${namespace}:${looksEncrypted(value) ? 'undecryptable' : 'plaintext'}`;

  it('an undecryptable value and a plaintext one do not silence each other', () => {
    // Keyed on the namespace alone, whichever came first would suppress the other for the rest
    // of the process — and the one that gets swallowed is the one worth reading.
    const seen = new Set<string>();
    seen.add(warnKey('user_access:key', 'clé-en-clair'));
    expect(seen.has(warnKey('user_access:key', ciphertext))).toBe(false);
  });

  it('repeats of the same kind stay deduplicated', () => {
    expect(warnKey('user_access:key', ciphertext)).toBe(warnKey('user_access:key', `${STORAGE_PAYLOAD_VERSION}:x:y:z:w`));
  });

  it('separates namespaces', () => {
    expect(warnKey('user_access:key', ciphertext)).not.toBe(warnKey('user_access:secret', ciphertext));
  });
});
