/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export interface VoiceProviderSeed {
  name: string;
  slug: string;
  type: string;
  capabilities: string[];
  baseUrl: string;
  website: string;
  signupUrl: string;
}

export const VOICE_PROVIDER_SEEDS: VoiceProviderSeed[] = [
  {
    name: 'Google Cloud',
    slug: 'google-cloud',
    type: 'google-cloud',
    capabilities: ['tts', 'stt'],
    baseUrl: 'https://texttospeech.googleapis.com/v1',
    website: 'https://cloud.google.com/text-to-speech',
    signupUrl: 'https://console.cloud.google.com/',
  },
  {
    name: 'Amazon Polly',
    slug: 'aws-polly',
    type: 'aws-polly',
    capabilities: ['tts'],
    baseUrl: 'https://polly.us-east-1.amazonaws.com',
    website: 'https://aws.amazon.com/polly/',
    signupUrl: 'https://aws.amazon.com/console/',
  },
  {
    name: 'Azure TTS',
    slug: 'azure-tts',
    type: 'azure-tts',
    capabilities: ['tts'],
    baseUrl: 'https://{region}.tts.speech.microsoft.com',
    website: 'https://azure.microsoft.com/en-us/products/ai-services/text-to-speech',
    signupUrl: 'https://portal.azure.com/',
  },
  {
    name: 'ElevenLabs',
    slug: 'elevenlabs',
    type: 'elevenlabs',
    capabilities: ['tts', 's2s'],
    baseUrl: 'https://api.elevenlabs.io/v1',
    website: 'https://elevenlabs.io',
    signupUrl: 'https://elevenlabs.io/sign-up',
  },
  {
    name: 'Deepgram',
    slug: 'deepgram',
    type: 'deepgram',
    capabilities: ['stt', 's2s'],
    baseUrl: 'https://api.deepgram.com/v1',
    website: 'https://deepgram.com',
    signupUrl: 'https://console.deepgram.com/signup',
  },
  {
    name: 'AssemblyAI',
    slug: 'assemblyai',
    type: 'assemblyai',
    capabilities: ['stt'],
    baseUrl: 'https://api.assemblyai.com/v2',
    website: 'https://www.assemblyai.com',
    signupUrl: 'https://www.assemblyai.com/dashboard/signup',
  },
  {
    name: 'OpenAI',
    slug: 'openai',
    type: 'openai',
    capabilities: ['stt', 's2s'],
    baseUrl: 'https://api.openai.com/v1',
    website: 'https://openai.com',
    signupUrl: 'https://platform.openai.com/signup',
  },
  {
    name: 'Gladia',
    slug: 'gladia',
    type: 'gladia',
    capabilities: ['s2s'],
    baseUrl: 'https://api.gladia.io/v2',
    website: 'https://www.gladia.io',
    signupUrl: 'https://app.gladia.io/auth/signup',
  },
];
