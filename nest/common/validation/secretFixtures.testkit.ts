/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { randomBytes } from 'crypto';

/**
 * Secret-shaped fixtures for the specs of the validation traces, built at run time from random bytes: nothing
 * secret-looking is written in a source file (the secret scanner stays quiet) and no real value is ever used.
 */
export function secretFixtures(): Record<string, string> {
  const b64url = (bytes: number) => randomBytes(bytes).toString('base64url');
  const segment = (json: string) => Buffer.from(json).toString('base64url');
  return {
    jwt: [segment('{"alg":"HS256","typ":"JWT"}'), segment(`{"sub":"${b64url(6)}"}`), b64url(32)].join('.'),
    bearer: `${'Bear'}er ${b64url(24)}`,
    appToken: `${'tk'}_${b64url(24)}`,
    ctdKey: `${'ctd'}_${b64url(24)}`,
    mstKey: `${'mst'}_${b64url(20)}`,
    liveKey: `${'ac_'}live_${b64url(20)}`,
    stepUpProof: `${'sup'}_${b64url(24)}`,
    hex64: randomBytes(32).toString('hex'),
    evmKey: `0x${randomBytes(32).toString('hex')}`,
    base64: randomBytes(36).toString('base64'),
    pem: `-----BEGIN ${'PRIVATE'} KEY-----${b64url(30)}`,
    urlCredentials: `postgres://app:${b64url(12)}@db.internal:5432/app`,
    assignment: `password=${b64url(10)}`,
    uuid: '6f1c2b3a-9d8e-4f70-8a1b-2c3d4e5f6a7b',
  };
}

/** Whether `text` contains any 10-character window of `secret` (a partial leak counts as a leak). */
export function leaksSecret(text: string, secret: string): boolean {
  for (let at = 0; at + 10 <= secret.length; at += 1) {
    if (text.includes(secret.slice(at, at + 10))) return true;
  }
  return false;
}
