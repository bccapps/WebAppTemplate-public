/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { randomBytes } from 'crypto';
import { SECRET_FORMATS, SECRET_OAUTH_FAMILY, secretCharsetClass, type SecretCharset, type SecretFormat } from './secretFormats';

/**
 * Secret-shaped fixtures for the specs of the validation traces, built at run time from random bytes: nothing
 * secret-looking is written in a source file (the secret scanner stays quiet) and no real value is ever used.
 */
const b64url = (bytes: number) => randomBytes(bytes).toString('base64url');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const pick = (alphabet: string, length: number) => Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
/** Random string of `length` from `alphabet` that contains at least one character of `required`. */
const withOne = (alphabet: string, required: string, length: number) => `${pick(required, 1)}${pick(alphabet, length - 1)}`;

export function secretFixtures(): Record<string, string> {
  const segment = (json: string) => Buffer.from(json).toString('base64url');
  return {
    jwt: [segment('{"alg":"HS256","typ":"JWT"}'), segment(`{"sub":"${b64url(6)}"}`), b64url(32)].join('.'),
    bearer: `${'Bear'}er ${b64url(24)}`,
    appToken: `${'tk'}_${b64url(24)}`,
    ctdKey: `${'ctd'}_${b64url(24)}`,
    mstKey: `${'mst'}_${b64url(20)}`,
    liveKey: `${'ac_'}live_${b64url(20)}`,
    stepUpProof: `${'sup'}_${b64url(24)}`,
    hex64: hex(32),
    evmKey: `0x${hex(32)}`,
    base64: randomBytes(36).toString('base64'),
    pem: `-----BEGIN ${'PRIVATE'} KEY-----${b64url(30)}`,
    urlCredentials: `postgres://app:${b64url(12)}@db.internal:5432/app`,
    assignment: `password=${b64url(10)}`,
    uuid: '6f1c2b3a-9d8e-4f70-8a1b-2c3d4e5f6a7b',
  };
}

/** A Luhn-valid 16-digit test card number (the classic `4111…` test card). */
export const TEST_CARD = ['4111', '1111', '1111', '1111'].join('');

/** [label, fields, the secret that must not appear] — the review's MUST_NOT_LEAK set (fields traced with `"*"` rules). */
export function mustNotLeakCases(): [string, Record<string, unknown>, string][] {
  const pwd = `Hx${pick('abcdefghijklmnopqrstuvwxyz', 6)}2026!`;
  const hex16 = `${pick('abcdef', 1)}9${pick('0123456789abcdef', 14)}`;
  const spacedCard = TEST_CARD.replace(/(\d{4})(?=\d)/g, '$1 ');
  const totp = pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16);
  const lower16 = withOne('abcdefghijklmnopqrstuvwxyz0123456789', '0123456789', 16);
  const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const tok = `${'tk'}_${b64url(18)}`;
  const hex32 = `a${hex(16).slice(1)}`;
  const sess = `s${b64url(15)}`;
  return [
    ['pass', { pass: pwd }, pwd], ['newPass', { newPass: pwd }, pwd], ['pass_confirm', { pass_confirm: pwd }, pwd], ['pw', { pw: pwd }, pwd],
    ['mdp', { mdp: pwd }, pwd], ['creds', { creds: pwd }, pwd], ['sid', { sid: sess }, sess], ['nonce', { nonce: hex16 }, hex16], ['sig', { sig: hex16 }, hex16],
    ['hex16 value', { value: hex16 }, hex16], ['TOTP base32 16', { value: totp }, totp], ['16 lower-case key', { value: lower16 }, lower16],
    ['cvv', { cvv: '123' }, '123'], ['card string', { detail: TEST_CARD }, TEST_CARD], ['card number', { amount: Number(TEST_CARD) }, TEST_CARD],
    ['card spaced', { detail: spacedCard }, spacedCard], ['card under cc', { cc: TEST_CARD }, TEST_CARD],
    ['mnemonic 12 words', { words: mnemonic }, mnemonic], ['OTP under verification', { verification: 483920 }, '483920'], ['OTP under entered', { entered: '483920' }, '483920'],
    ['userIp', { userIp: '203.0.113.42' }, '203.0.113.42'], ['remoteAddr', { remoteAddr: '203.0.113.42' }, '203.0.113.42'], ['ipAddr v6', { ipAddr: '2001:db8::1:42' }, '2001:db8::1:42'],
    ['ips', { ips: ['203.0.113.42'] }, '203.0.113.42'], ['IP in text', { note: 'blocked 203.0.113.42 twice' }, '203.0.113.42'], ['IPv6 in text', { note: 'from 2001:db8::1:42' }, '2001:db8::1:42'],
    ['tel', { tel: '+33612345678' }, '+33612345678'], ['mobile', { mobile: '+33612345678' }, '+33612345678'], ['name', { name: 'Jean Dupont' }, 'Jean Dupont'],
    ['address', { address: '12 rue de la Paix' }, '12 rue de la Paix'], ['dob', { dob: '1990-01-01' }, '1990-01-01'], ['login', { login: 'jdupont' }, 'jdupont'],
    ['token as key', { [tok]: true }, tok], ['hex32 as key', { [hex32]: 1 }, hex32], ['session as key', { [sess]: 'active' }, sess],
    ['password in text', { detail: `login failed with password ${pwd}` }, pwd], ['pseudo e-mail', { input: `Summer@${pick('abcdefgh', 8)}1` }, '@'],
    ['smscode (one word)', { smscode: '483920' }, '483920'], ['pincode number', { pincode: 4821 }, '4821'], ['authcode', { authcode: 'Xy7Q2' }, 'Xy7Q2'],
    ['backupcodes', { backupcodes: '8f3k2 9d2k1' }, '8f3k2'], ['passcode', { passcode: 'hunter22' }, 'hunter22'], ['passkey', { passkey: 'correcthorse' }, 'correcthorse'],
    ['privkey', { privkey: 'abc' }, 'abc'], ['mfa', { mfa: '483920' }, '483920'], ['2fa', { code2fa: '483920' }, '483920'],
    ['mnemonic dash-joined', { detail: mnemonic.replace(/ /g, '-') }, 'absurd'], ['mnemonic underscore-joined', { detail: mnemonic.replace(/ /g, '_') }, 'absurd'],
    ['mnemonic numbered', { detail: mnemonic.split(' ').map((w, i) => `${i + 1}. ${w}`).join(' ') }, 'absurd'],
    ['mnemonic capitalized', { detail: mnemonic.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') }, 'Absurd'],
    ['mnemonic 11 words', { detail: mnemonic.split(' ').slice(0, 11).join(' ') }, 'absurd'],
    ['phone in text', { detail: 'call +33 6 12 34 56 78' }, '12 34 56 78'], ['phone under a neutral key', { contact: '+33612345678' }, '+33612345678'],
  ];
}

/** [label, value] — the review's MUST_STAY_HIDDEN set: each value, under a neutral field name, must come out fingerprinted. */
export function mustStayHiddenCases(): [string, string][] {
  const tg = `${1_000_000_000 + randomBytes(3).readUIntBE(0, 3)}:AA${b64url(25).slice(0, 33)}`;
  return [
    ['telegram bot token', tg], ['stripe pk_live', `${'pk_'}live_${b64url(18)}`], ['stripe rk_live', `${'rk_'}live_${b64url(18)}`],
    ['google AIza', `${'AI'}za${b64url(26).slice(0, 35)}`], ['github_pat', `${'github'}_pat_${b64url(30)}`],
    ['slack xapp', `${'xa'}pp-1-A${hex(4).toUpperCase()}-${Date.now()}-${hex(32)}`], ['npm token', `${'np'}m_${b64url(27).slice(0, 36)}`],
    ['openai sk-proj', `${'sk'}-proj-${b64url(30)}`], ['anthropic sk-ant', `${'sk'}-ant-api03-${b64url(30)}`],
    ['sendgrid SG.', `${'S'}G.${b64url(16).slice(0, 22)}.${b64url(32).slice(0, 43)}`], ['percent-encoded token', encodeURIComponent(`${'tk'}_${b64url(24)}/x+y`)],
    ['zero-width prefix', `t\u200bk_${b64url(24)}`], ['homoglyph prefix', `\u0442k_${b64url(24)}`], ['full-width prefix', `\uff54\uff4b_${b64url(24)}`],
    ['hex32', hex(16)], ['hex12', withOne('0123456789abcdef', 'abcdef', 11).concat('7')], ['JWT-like', `${b64url(20)}.${b64url(40)}.${b64url(32)}`],
    ['connect.sid', `connect.sid=s%3A${b64url(24)}.${b64url(32)}`], ['base64 24', randomBytes(18).toString('base64')],
  ];
}

/** The characters of a registry charset (`A-Za-z0-9_-` → `AB…Zab…z01…9_-`). */
export function charsetAlphabet(charset: SecretCharset): string {
  return secretCharsetClass(charset).replace(/(.)-(.)/g, (_, from: string, to: string) =>
    Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (__, i) => String.fromCharCode(from.charCodeAt(0) + i)).join(''),
  );
}

/** A random body of `length` characters of `charset` (rejection sampling: unbiased, like the minting code). */
export function randomSecretBody(charset: SecretCharset, length: number): string {
  const alphabet = charsetAlphabet(charset);
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
  }
  return out;
}

export interface SecretFormatFixture {
  format: SecretFormat;
  kind: 'key' | 'oauth';
  /** A random value of that format, built at run time (never written in a source file). */
  value: string;
}

/** One random value per registered format, plus one per OAuth marker of the formats that have OAuth tokens. */
export function secretFormatFixtures(): SecretFormatFixture[] {
  const fixtures: SecretFormatFixture[] = [];
  for (const format of SECRET_FORMATS) {
    const length = format.length ?? Math.min(format.maxLength ?? 32, 32);
    fixtures.push({ format, kind: 'key', value: `${format.prefix}${randomSecretBody(format.charset, length)}` });
    if (!format.oauth) continue;
    for (const marker of SECRET_OAUTH_FAMILY.markers) {
      fixtures.push({ format, kind: 'oauth', value: `${format.prefix}${marker}${randomSecretBody(SECRET_OAUTH_FAMILY.charset, SECRET_OAUTH_FAMILY.length)}` });
    }
  }
  return fixtures;
}

/** Whether `text` contains any `window`-character slice of `secret` (a partial leak counts as a leak). */
export function leaksSecret(text: string, secret: string, window = 10): boolean {
  if (secret.length < window) return text.includes(secret);
  for (let at = 0; at + window <= secret.length; at += 1) {
    if (text.includes(secret.slice(at, at + window))) return true;
  }
  return false;
}
