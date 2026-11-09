/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Pure helpers of the user-access dispatch (`synthesizeForUser` / `transcribeForUser`): what to ask each provider so that
 * the answer is directly playable (WAV or raw L16) and what voice / locale to use when the caller only knows a 2-letter language.
 */

import type { VoiceCallParams } from '../types/VoiceCallParams';

type Gender = 'male' | 'female';

/** Minimal shape of an access (admin or user) with its provider, enough to build the call parameters. */
export interface AccessWithProvider {
  id: number;
  label: string;
  baseUrlOverride: string | null;
  username: string | null;
  password: string | null;
  providerConfig: Record<string, any> | null;
  provider?: { type: string; baseUrl: string; capabilities: string[]; name: string } | null;
}

export function toCallParams(access: AccessWithProvider): VoiceCallParams {
  const provider = access.provider!;
  return {
    accessId: access.id,
    label: access.label,
    type: provider.type,
    baseUrl: access.baseUrlOverride ?? provider.baseUrl,
    username: access.username,
    password: access.password,
    providerConfig: access.providerConfig,
  };
}

const LOCALES: Record<string, string> = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL' };

/** `fr` -> `fr-FR`; an already regional tag is kept; Whisper / Deepgram / AssemblyAI take the 2-letter code as is. */
export function localeFor(providerType: string, language: string | undefined): string | undefined {
  if (!language) return undefined;
  const regional = ['google-cloud', 'azure-tts', 'aws-polly'].includes(providerType);
  if (!regional || language.includes('-')) return language;
  return LOCALES[language.toLowerCase()] ?? language;
}

const DEFAULT_VOICES: Record<string, Record<string, Record<Gender, string>>> = {
  'azure-tts': {
    fr: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
    en: { female: 'en-US-JennyNeural', male: 'en-US-GuyNeural' },
  },
  'google-cloud': {
    fr: { female: 'fr-FR-Neural2-A', male: 'fr-FR-Neural2-B' },
    en: { female: 'en-US-Neural2-F', male: 'en-US-Neural2-D' },
  },
  'aws-polly': {
    fr: { female: 'Lea', male: 'Mathieu' },
    en: { female: 'Joanna', male: 'Matthew' },
  },
  // Multilingual model: the voice is not tied to a language.
  elevenlabs: {
    '*': { female: 'EXAVITQu4vr4xnSDxMaL', male: 'pNInz6obpgDQGcFmaJgB' },
  },
  // OpenAI voices are multilingual (optimised for English); `onyx` also exists on the tts-1 models.
  openai: {
    '*': { female: 'coral', male: 'onyx' },
  },
};

/** Voice to use when the request names none: the access' `providerConfig.voice`, else a default per provider / language / gender. */
export function defaultVoiceFor(
  providerType: string,
  language: string | undefined,
  gender: Gender | undefined,
  providerConfig: Record<string, any> | null,
): string | undefined {
  const configured = providerConfig?.voice;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const byLang = DEFAULT_VOICES[providerType];
  if (!byLang) return undefined;
  const short = (language ?? '').slice(0, 2).toLowerCase();
  const voices = byLang[short] ?? byLang['*'];
  return voices?.[gender ?? 'female'];
}

/** Output format asked from each TTS provider: the playable ones (WAV, or raw 16-bit PCM). */
export function playableFormat(providerType: string): 'wav' | 'pcm' | undefined {
  switch (providerType) {
    case 'google-cloud':
    case 'azure-tts':
      return 'wav';
    case 'aws-polly':
    case 'elevenlabs':
    case 'openai':
      return 'pcm';
    default:
      return undefined;
  }
}

/** Sample rate of the raw PCM each provider returns for `pcm` (Polly 16 kHz, ElevenLabs `pcm_16000`, OpenAI 24 kHz). */
export function pcmRateFor(providerType: string): number {
  return providerType === 'aws-polly' || providerType === 'elevenlabs' ? 16000 : 24000; // OpenAI pcm: 24 kHz
}

/** Content type voice-live decodes: `audio/wav`, or `audio/L16;rate=N;channels=1` for raw PCM. */
export function normalizeContentType(providerType: string, contentType: string): { contentType: string; sampleRate?: number } {
  if (/pcm|l16/i.test(contentType)) {
    const rate = /rate=(\d+)/i.exec(contentType);
    const sampleRate = rate ? Number(rate[1]) : pcmRateFor(providerType);
    return { contentType: `audio/L16;rate=${sampleRate};channels=1`, sampleRate };
  }
  if (/wav|wave/i.test(contentType)) {
    return { contentType: 'audio/wav' };
  }
  return { contentType };
}

/** Duration of a PCM WAV (from its header), or `undefined` when the buffer is not a plain RIFF/WAVE one. */
export function wavDurationMs(audio: Uint8Array): number | undefined {
  if (audio.byteLength < 44) return undefined;
  const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = String.fromCharCode(audio[0], audio[1], audio[2], audio[3], audio[8], audio[9], audio[10], audio[11]);
  if (tag !== 'RIFFWAVE') return undefined;
  const byteRate = dv.getUint32(28, true);
  if (!byteRate) return undefined;
  return Math.round(((audio.byteLength - 44) / byteRate) * 1000);
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'];

/**
 * Whether a user-supplied base URL may be called by the server with the user's key: https, a public-looking DNS name (no IP
 * literal, no localhost / private suffix, no embedded credentials). Keeps the user routes from being a request proxy into the
 * hub's network. Does not resolve DNS (a name pointing to a private address is not detected).
 */
export function isSafeUserBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.replace('{region}', 'region'));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.')) return false;
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || host === 'localhost') return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** A `region` (Azure / Polly) goes into a host name: only a plain region id is accepted for a user's access. */
export function isSafeRegion(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && /^[a-z0-9-]{2,32}$/i.test(value));
}
