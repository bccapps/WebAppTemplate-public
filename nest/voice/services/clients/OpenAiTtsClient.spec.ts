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
import { OPENAI_TTS_MAX_CHARS, OpenAiTtsClient, buildOpenAiSpeechBody } from './OpenAiTtsClient';
import type { VoiceCallParams } from '../../types/VoiceCallParams';

const params = (providerConfig: Record<string, unknown> | null = null): VoiceCallParams => ({
  accessId: 1, label: 'a', type: 'openai', baseUrl: 'https://api.openai.com/v1/', username: null, password: 'sk-test', providerConfig,
});

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function mockFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? new Uint8Array([1, 2, 3, 4]) : 'denied', { status });
  }) as unknown as typeof fetch;
  return calls;
}

describe('OpenAiTtsClient', () => {
  it('posts the documented body to /audio/speech with the bearer key and returns raw 24 kHz PCM', async () => {
    const calls = mockFetch();
    const out = await new OpenAiTtsClient().synthesize(params(), { text: 'Bonjour', voice: 'coral', outputFormat: 'pcm' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/speech');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Bonjour', voice: 'coral', response_format: 'pcm' });
    expect(out.contentType).toBe('audio/L16;rate=24000;channels=1');
    expect([...out.audio]).toEqual([1, 2, 3, 4]);
  });

  it('asks for WAV, and mp3 by default', async () => {
    const calls = mockFetch();
    const wav = await new OpenAiTtsClient().synthesize(params(), { text: 'x', outputFormat: 'wav' });
    const mp3 = await new OpenAiTtsClient().synthesize(params(), { text: 'x' });
    expect(JSON.parse(calls[0].init.body as string).response_format).toBe('wav');
    expect(wav.contentType).toBe('audio/wav');
    expect(JSON.parse(calls[1].init.body as string).response_format).toBe('mp3');
    expect(mp3.contentType).toBe('audio/mpeg');
  });

  it('sends instructions to gpt models and speed to tts-1 models only', () => {
    const request = { text: 'x', speed: 1.5 };
    expect(buildOpenAiSpeechBody(params({ instructions: ' calm ' }), request)).toMatchObject({ model: 'gpt-4o-mini-tts', instructions: 'calm' });
    expect(buildOpenAiSpeechBody(params({ instructions: 'calm' }), request)).not.toHaveProperty('speed');
    const legacy = buildOpenAiSpeechBody(params({ model: 'tts-1-hd', instructions: 'calm' }), { text: 'x', speed: 9 });
    expect(legacy).toMatchObject({ model: 'tts-1-hd', speed: 4 });
    expect(legacy).not.toHaveProperty('instructions');
  });

  it('refuses an empty or too long text without calling the API', async () => {
    const calls = mockFetch();
    await expect(new OpenAiTtsClient().synthesize(params(), { text: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(new OpenAiTtsClient().synthesize(params(), { text: 'x'.repeat(OPENAI_TTS_MAX_CHARS + 1) })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('fails with the status only (the key never reaches the error)', async () => {
    mockFetch(401);
    await expect(new OpenAiTtsClient().synthesize(params(), { text: 'x' })).rejects.toThrow('OpenAI TTS failed: 401');
  });
});
