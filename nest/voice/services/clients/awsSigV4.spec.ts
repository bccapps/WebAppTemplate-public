/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createHash } from 'crypto';
import { describe, expect, it } from '@jest/globals';
import { canonicalRequest, canonicalUri, signingKey, signSigV4, uriEncode } from './awsSigV4';

/** The example credentials of the AWS documentation and of its signature test suite (public, not real). */
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2015-08-30T12:36:00Z');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const signatureOf = (headers: Record<string, string>): string => /Signature=([0-9a-f]{64})$/.exec(headers.authorization)![1];

describe('AWS Signature Version 4 (official vectors)', () => {
  it('matches the documented IAM ListUsers example (canonical request, signing key, signature)', () => {
    const url = 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' };
    const signed = signSigV4({ method: 'GET', url, headers, body: '', region: 'us-east-1', service: 'iam', now: NOW }, CREDENTIALS);
    const canonical = canonicalRequest('GET', new URL(url), { ...headers, host: 'iam.amazonaws.com', 'x-amz-date': '20150830T123600Z' }, '');
    expect(canonical).toBe([
      'GET', '/', 'Action=ListUsers&Version=2010-05-08',
      'content-type:application/x-www-form-urlencoded; charset=utf-8', 'host:iam.amazonaws.com', 'x-amz-date:20150830T123600Z', '',
      'content-type;host;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'));
    expect(sha256(canonical)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(signingKey(CREDENTIALS.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex'))
      .toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
    expect(signatureOf(signed)).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  const suite: Array<[string, string, string, Record<string, string>, string, string]> = [
    ['get-vanilla', 'GET', 'https://example.amazonaws.com/', {}, '', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
    ['post-vanilla', 'POST', 'https://example.amazonaws.com/', {}, '', '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b'],
    [
      'get-vanilla-query-order-key-case', 'GET', 'https://example.amazonaws.com/?Param2=value2&Param1=value1', {}, '',
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    ],
    [
      'post-x-www-form-urlencoded', 'POST', 'https://example.amazonaws.com/', { 'Content-Type': 'application/x-www-form-urlencoded' },
      'Param1=value1', 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    ],
  ];
  it.each(suite)('test suite vector %s', (_name, method, url, headers, body, signature) => {
    const signed = signSigV4({ method, url, headers, body, region: 'us-east-1', service: 'service', now: NOW }, CREDENTIALS);
    expect(signatureOf(signed)).toBe(signature);
  });

  it('adds host and x-amz-date, signs the session token of temporary credentials', () => {
    const signed = signSigV4(
      { method: 'POST', url: 'https://polly.eu-west-3.amazonaws.com:8443/v1/speech', headers: {}, body: '{}', region: 'eu-west-3', service: 'polly', now: NOW },
      { ...CREDENTIALS, sessionToken: 'TOKEN' },
    );
    expect(signed.host).toBe('polly.eu-west-3.amazonaws.com:8443');
    expect(signed['x-amz-date']).toBe('20150830T123600Z');
    expect(signed['x-amz-security-token']).toBe('TOKEN');
    expect(signed.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });

  it('encodes per RFC 3986 and twice in the canonical path', () => {
    expect(uriEncode("a b/c!'()*~")).toBe('a%20b%2Fc%21%27%28%29%2A~');
    expect(canonicalUri('/v1/a b')).toBe('/v1/a%2520b');
  });
});
