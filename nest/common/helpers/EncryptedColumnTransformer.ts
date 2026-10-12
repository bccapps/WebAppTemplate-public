/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ValueTransformer } from 'typeorm';
import { STORAGE_PAYLOAD_VERSION } from '../constants/crypt.constants';
import { CryptService } from '../services/CryptService';

const cryptService = new CryptService();

// Track which namespaces have already emitted a fallback warning (once per process, per kind).
const _warnedNamespaces = new Set<string>();

/**
 * Does this value CLAIM to be ciphertext?
 *
 * `encryptForStorage` emits exactly `version:salt:iv:tag:ciphertext`. A stored value in that
 * shape was written by us, encrypted; a value in any other shape is a legacy plaintext one.
 * The distinction matters because the two failure modes below are opposites, and conflating
 * them is how an unreadable credential turns into an unexplainable venue rejection.
 */
function looksEncrypted(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 5 && parts[0] === STORAGE_PAYLOAD_VERSION;
}

export function createEncryptedColumnTransformer(namespace: string): ValueTransformer {
  return {
    to(value: unknown) {
      if (value === undefined || value === null || value === '') {
        return value as string | null | undefined;
      }
      return cryptService.encryptForStorage(value, namespace);
    },
    from(value: string | null) {
      if (value === undefined || value === null || value === '') {
        return value;
      }
      try {
        return cryptService.decryptFromStorage(value, namespace);
      } catch {
        if (process.env.CRYPT_STRICT === 'true') {
          throw new Error(
            `[EncryptedColumnTransformer] CRYPT_STRICT=true: decryption failed for namespace "${namespace}". ` +
            'Run scripts/reencryptPlaintext.ts to migrate plaintext values before enabling strict mode.',
          );
        }

        // TWO OPPOSITE FAILURES SHARE THIS BRANCH — say which one happened.
        //
        // A value that is NOT in our ciphertext shape is a legacy plaintext one: returning it is
        // correct, and that is what this fallback was built for.
        //
        // A value that IS in our shape and still fails is UNREADABLE ciphertext — wrong master
        // key, wrong namespace, or corruption. Returning it hands the caller a base64 blob that
        // it will use as a credential, and the venue answers `Signature check failed` with no
        // hint that the cause is local. That symptom cost a full investigation on 2026-08-13
        // (the trail led to Aster, whose key turned out to be perfectly fine). Reading "plaintext
        // fallback" in the log while the value is plainly ciphertext points the reader away from
        // the cause; this is not a cosmetic distinction.
        //
        // The value is still returned rather than thrown: this runs on every row hydration, and
        // failing a listing endpoint outright is a worse outcome than a loud log. CRYPT_STRICT
        // above is the switch for callers that want it fatal.
        const encryptedShape = looksEncrypted(value);
        const warnKey = `${namespace}:${encryptedShape ? 'undecryptable' : 'plaintext'}`;
        if (!_warnedNamespaces.has(warnKey)) {
          _warnedNamespaces.add(warnKey);
          if (encryptedShape) {
            console.error(
              `[EncryptedColumnTransformer] UNDECRYPTABLE ciphertext for namespace "${namespace}". ` +
              'The stored value IS encrypted (correct format and version) but failed authentication: ' +
              'wrong CRYPT_DB_MASTER_KEY, wrong namespace, or corrupted data. ' +
              'It is being returned AS-IS, so any consumer will use ciphertext as a credential and ' +
              'the remote will reject it with an opaque authentication error. ' +
              'NOTE: the namespace follows the ENTITY PROPERTY name, not the column name ' +
              '(column `lkey` → property `key` → namespace `user_access:key`).',
            );
          } else {
            console.warn(
              `[EncryptedColumnTransformer] Plaintext fallback encountered for namespace "${namespace}". ` +
              'This means some values were stored unencrypted (legacy). ' +
              'Run scripts/reencryptPlaintext.ts to re-encrypt them. ' +
              'Set CRYPT_STRICT=true to turn this into an error.',
            );
          }
        }
        return value;
      }
    },
  };
}
