/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ModuleConfigSchema } from '../common/types/ModuleConfigSchema';

export const voiceConfigSchema: ModuleConfigSchema = {
  moduleId: 'voice',
  moduleName: 'Voice Services',
  description: 'TTS, STT, and S2S voice provider configuration',
  icon: 'record_voice_over',
  fields: [
    {
      key: 'voice_defaultTtsAccessId',
      label: 'Default TTS Access ID',
      description: 'ID of the global default voice access for text-to-speech',
      type: 'string',
      defaultValue: '',
      group: 'general',
    },
    {
      key: 'voice_defaultSttAccessId',
      label: 'Default STT Access ID',
      description: 'ID of the global default voice access for speech-to-text',
      type: 'string',
      defaultValue: '',
      group: 'general',
    },
    {
      key: 'voice_defaultS2sAccessId',
      label: 'Default S2S Access ID',
      description: 'ID of the global default voice access for speech-to-speech',
      type: 'string',
      defaultValue: '',
      group: 'general',
    },
    {
      key: 'voice_allowUserProviders',
      label: 'Allow user providers',
      description: 'When disabled, users cannot configure their own voice providers and must use the system default',
      type: 'boolean',
      defaultValue: false,
      group: 'general',
    },
    {
      key: 'voice_maxTtsChars',
      label: 'Max TTS characters',
      description: 'Maximum number of characters allowed in a single TTS request',
      type: 'number',
      defaultValue: 5000,
      group: 'performance',
      validation: { min: 100, max: 100000 },
    },
    {
      key: 'voice_maxSttDurationMs',
      label: 'Max STT duration (ms)',
      description: 'Maximum audio duration in milliseconds for a single STT request',
      type: 'number',
      defaultValue: 300000,
      group: 'performance',
      validation: { min: 10000, max: 3600000 },
    },
  ],
};
