/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VoiceUserDispatchService } from './VoiceUserDispatchService';

const OWNER = 7;
const provider = (type: string, capabilities: string[]) => ({ type, name: type, baseUrl: 'https://p.test', capabilities });
const access = (id: number, userId: number, type: string, capabilities: string[], extra: Record<string, unknown> = {}) => ({
  id, userId, label: `a${id}`, baseUrlOverride: null, username: null, password: 'SECRET-KEY', providerConfig: null,
  provider: provider(type, capabilities), ...extra,
});

function build(opts: { enabled?: boolean; accesses?: Array<ReturnType<typeof access>> } = {}) {
  const store = opts.accesses ?? [];
  const userAccesses = { getAccessWithSecrets: jest.fn(async (uid: number, id: number) => store.find((a) => a.id === id && a.userId === uid) ?? null) };
  const config = { getResolvedValue: jest.fn((k: string) => (k === 'voice_allowUserProviders' ? (opts.enabled ?? true) : k === 'voice_maxTtsChars' ? 50 : k === 'voice_maxSttDurationMs' ? 3000 : undefined)) };
  const tts = (contentType: string) => ({ synthesize: jest.fn(async (_params: unknown, _request: unknown) => ({ audio: Buffer.from([1, 2]), contentType })) });
  const stt = () => ({ transcribe: jest.fn(async (_params: unknown, _request: unknown) => ({ text: 'bonjour', language: 'fr' })) });
  const clients = { google: tts('audio/wav'), polly: tts('audio/pcm'), azure: tts('audio/wav'), eleven: tts('audio/pcm'), gstt: stt(), dg: stt(), aai: stt(), whisper: stt() };
  const service = new VoiceUserDispatchService(
    userAccesses as never, config as never, clients.google as never, clients.polly as never, clients.azure as never, clients.eleven as never,
    clients.gstt as never, clients.dg as never, clients.aai as never, clients.whisper as never,
  );
  return { service, clients, userAccesses };
}

describe('VoiceUserDispatchService', () => {
  it('uses only an access the user owns (404 for someone else\'s, same message as a missing one)', async () => {
    const { service, clients } = build({ accesses: [access(1, 99, 'azure-tts', ['tts'])] });
    await expect(service.synthesize(OWNER, 1, { text: 'hi' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.synthesize(OWNER, 2, { text: 'hi' })).rejects.toBeInstanceOf(NotFoundException);
    expect(clients.azure.synthesize).not.toHaveBeenCalled();
  });

  it('refuses when user providers are disabled', async () => {
    const { service } = build({ enabled: false, accesses: [access(1, OWNER, 'azure-tts', ['tts'])] });
    await expect(service.synthesize(OWNER, 1, { text: 'hi' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.transcribe(OWNER, 1, { audio: Buffer.from([1]), contentType: 'audio/wav' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a provider without the capability or a text too long', async () => {
    const { service } = build({ accesses: [access(1, OWNER, 'deepgram', ['stt']), access(2, OWNER, 'azure-tts', ['tts'])] });
    await expect(service.synthesize(OWNER, 1, { text: 'hi' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.synthesize(OWNER, 2, { text: 'x'.repeat(51) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('asks Azure for WAV with a French voice, locale and the gender asked', async () => {
    const { service, clients } = build({ accesses: [access(2, OWNER, 'azure-tts', ['tts'])] });
    const out = await service.synthesize(OWNER, 2, { text: 'salut', language: 'fr', gender: 'male' });
    expect(out.contentType).toBe('audio/wav');
    expect(clients.azure.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'SECRET-KEY', type: 'azure-tts' }),
      expect.objectContaining({ language: 'fr-FR', voice: 'fr-FR-HenriNeural', outputFormat: 'wav' }),
    );
  });

  it('returns raw PCM from Polly tagged as L16 with its rate', async () => {
    const { service } = build({ accesses: [access(3, OWNER, 'aws-polly', ['tts'])] });
    const out = await service.synthesize(OWNER, 3, { text: 'salut', language: 'fr' });
    expect(out.contentType).toBe('audio/L16;rate=16000;channels=1');
    expect(out.sampleRate).toBe(16000);
  });

  it('transcribes through the matching client, detecting the language when none is given', async () => {
    const { service, clients } = build({ accesses: [access(4, OWNER, 'deepgram', ['stt']), access(5, OWNER, 'openai', ['stt'])] });
    const out = await service.transcribe(OWNER, 4, { audio: Buffer.from([1, 2, 3]), contentType: 'audio/wav' });
    expect(out).toEqual({ text: 'bonjour', language: 'fr' });
    expect(clients.dg.transcribe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detectLanguage: true, language: undefined }));
    await service.transcribe(OWNER, 5, { audio: Buffer.from([1]), contentType: 'audio/wav', language: 'fr' });
    expect(clients.whisper.transcribe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ detectLanguage: false, language: 'fr' }));
  });

  it('rejects audio longer than voice_maxSttDurationMs', async () => {
    const { service } = build({ accesses: [access(4, OWNER, 'deepgram', ['stt'])] });
    const audio = Buffer.alloc(44 + 16000 * 2 * 5);
    audio.write('RIFF', 0); audio.write('WAVE', 8); audio.writeUInt32LE(32000, 28);
    await expect(service.transcribe(OWNER, 4, { audio, contentType: 'audio/wav' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
