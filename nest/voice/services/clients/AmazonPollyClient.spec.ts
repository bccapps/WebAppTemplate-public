/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AmazonPollyClient, buildPollyBody, pollyEndpoint, pollyRegion } from './AmazonPollyClient';
import type { VoiceCallParams } from '../../types/VoiceCallParams';

const params = (over: Partial<VoiceCallParams> = {}): VoiceCallParams => ({
  accessId: 1, label: 'a', type: 'aws-polly', baseUrl: 'https://polly.{region}.amazonaws.com', username: 'AKIDEXAMPLE',
  password: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', providerConfig: { region: 'eu-west-3' }, ...over,
});

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? new Uint8Array([9, 8]) : 'denied', { status });
  }) as unknown as typeof fetch;
  return calls;
}

describe('AmazonPollyClient', () => {
  it('signs the request with SigV4 (host, x-amz-date, scope of the configured region) and never sends the secret', async () => {
    const calls = mockFetch();
    const out = await new AmazonPollyClient().synthesize(params(), { text: 'Salut', voice: 'Lea', language: 'fr-FR', outputFormat: 'pcm' });
    expect(calls[0].url).toBe('https://polly.eu-west-3.amazonaws.com/v1/speech');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.host).toBe('polly.eu-west-3.amazonaws.com');
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${headers['x-amz-date'].slice(0, 8)}/eu-west-3/polly/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$`),
    );
    expect(JSON.stringify([...Object.values(headers), calls[0].init.body])).not.toContain('wJalrXUtnFEMI');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      Text: 'Salut', OutputFormat: 'pcm', VoiceId: 'Lea', SampleRate: '16000', LanguageCode: 'fr-FR',
    });
    expect(out.contentType).toBe('audio/L16;rate=16000;channels=1');
  });

  it('needs both an access key id and a secret', async () => {
    mockFetch();
    await expect(new AmazonPollyClient().synthesize(params({ username: null }), { text: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(new AmazonPollyClient().synthesize(params({ password: null }), { text: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('derives the region and endpoint, ignoring an invalid configured region', () => {
    expect(pollyRegion('https://polly.{region}.amazonaws.com', { region: 'ap-southeast-2' })).toBe('ap-southeast-2');
    expect(pollyRegion('https://polly.eu-central-1.amazonaws.com', null)).toBe('eu-central-1');
    expect(pollyRegion('https://polly.{region}.amazonaws.com', { region: 'evil.com/' })).toBe('us-east-1');
    expect(pollyEndpoint('https://polly.us-east-1.amazonaws.com/', 'eu-west-3')).toBe('https://polly.eu-west-3.amazonaws.com');
    expect(pollyEndpoint('https://polly.{region}.amazonaws.com', 'eu-west-3')).toBe('https://polly.eu-west-3.amazonaws.com');
  });

  it('adds Engine only for a known engine', () => {
    expect(buildPollyBody(params({ providerConfig: { engine: 'neural' } }), { text: 'x' })).toMatchObject({ Engine: 'neural', OutputFormat: 'mp3' });
    expect(buildPollyBody(params({ providerConfig: { engine: 'bogus' } }), { text: 'x' })).not.toHaveProperty('Engine');
  });

  it('fails with the status only', async () => {
    mockFetch(403);
    await expect(new AmazonPollyClient().synthesize(params(), { text: 'x' })).rejects.toThrow('Amazon Polly failed: 403');
  });
});
