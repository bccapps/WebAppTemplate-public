/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { defaultVoiceFor, localeFor, normalizeContentType, playableFormat, wavDurationMs } from './voiceUserDispatch';

function wav(seconds: number, rate = 16000): Uint8Array {
  const data = seconds * rate * 2;
  const out = new Uint8Array(44 + data);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  return out;
}

describe('voiceUserDispatch helpers', () => {
  it('expands 2-letter languages only for the providers that need a region', () => {
    expect(localeFor('google-cloud', 'fr')).toBe('fr-FR');
    expect(localeFor('azure-tts', 'en')).toBe('en-US');
    expect(localeFor('google-cloud', 'pt-BR')).toBe('pt-BR');
    expect(localeFor('openai', 'fr')).toBe('fr');
    expect(localeFor('deepgram', undefined)).toBeUndefined();
  });

  it('picks a voice: explicit config, then provider default by language and gender', () => {
    expect(defaultVoiceFor('azure-tts', 'fr', 'male', null)).toBe('fr-FR-HenriNeural');
    expect(defaultVoiceFor('azure-tts', 'fr', undefined, null)).toBe('fr-FR-DeniseNeural');
    expect(defaultVoiceFor('elevenlabs', 'fr', 'male', null)).toBe('pNInz6obpgDQGcFmaJgB');
    expect(defaultVoiceFor('aws-polly', 'fr', 'female', { voice: ' Celine ' })).toBe('Celine');
    expect(defaultVoiceFor('deepgram', 'fr', 'female', null)).toBeUndefined();
  });

  it('asks every TTS provider for a playable format', () => {
    expect(playableFormat('google-cloud')).toBe('wav');
    expect(playableFormat('aws-polly')).toBe('pcm');
    expect(playableFormat('unknown')).toBeUndefined();
  });

  it('tags raw PCM as L16 with its rate, keeps WAV and other types', () => {
    expect(normalizeContentType('aws-polly', 'audio/pcm')).toEqual({ contentType: 'audio/L16;rate=16000;channels=1', sampleRate: 16000 });
    expect(normalizeContentType('x', 'audio/L16;rate=22050')).toEqual({ contentType: 'audio/L16;rate=22050;channels=1', sampleRate: 22050 });
    expect(normalizeContentType('google-cloud', 'audio/wav')).toEqual({ contentType: 'audio/wav' });
    expect(normalizeContentType('x', 'audio/mpeg')).toEqual({ contentType: 'audio/mpeg' });
  });

  it('reads the duration of a WAV', () => {
    expect(wavDurationMs(wav(2))).toBe(2000);
    expect(wavDurationMs(new Uint8Array(10))).toBeUndefined();
    expect(wavDurationMs(new Uint8Array(100))).toBeUndefined();
  });
});
