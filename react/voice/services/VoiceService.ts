/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { HttpResult } from '../../common/core/http/HttpResult';
import { httpService } from '../../common/core/http/HttpService';
import { configurationService } from '../../common/services/ConfigurationService';
import type {
  VoiceAccessCredentialsPayload,
  VoiceProviderCatalogPayload,
} from '../types';
import { unwrap } from './unwrap';

function getBaseUrl(): string {
  return configurationService.getApiUrl('default');
}

class VoiceServiceImpl {
  // --- Provider Catalog ---

  listProviderCatalog(): HttpResult {
    return unwrap(httpService.get(`${getBaseUrl()}/voice-provider-catalog`));
  }

  createProviderCatalog(payload: VoiceProviderCatalogPayload): HttpResult {
    return unwrap(httpService.post(`${getBaseUrl()}/voice-provider-catalog`, payload));
  }

  updateProviderCatalog(id: number, payload: VoiceProviderCatalogPayload): HttpResult {
    return unwrap(httpService.put(`${getBaseUrl()}/voice-provider-catalog/${id}`, payload));
  }

  removeProviderCatalog(id: number): HttpResult {
    return httpService.delete(`${getBaseUrl()}/voice-provider-catalog/${id}`);
  }

  // --- Admin access (credentials) CRUD ---

  listAccesses(): HttpResult {
    return unwrap(httpService.get(`${getBaseUrl()}/voice-accesses`));
  }

  createAccess(payload: VoiceAccessCredentialsPayload): HttpResult {
    return unwrap(httpService.post(`${getBaseUrl()}/voice-accesses`, payload));
  }

  updateAccess(id: number, payload: VoiceAccessCredentialsPayload): HttpResult {
    return unwrap(httpService.put(`${getBaseUrl()}/voice-accesses/${id}`, payload));
  }

  removeAccess(id: number): HttpResult {
    return httpService.delete(`${getBaseUrl()}/voice-accesses/${id}`);
  }

  // --- User access (credentials) CRUD ---

  listUserAccesses(): HttpResult {
    return unwrap(httpService.get(`${getBaseUrl()}/user/voice-accesses`));
  }

  createUserAccess(payload: VoiceAccessCredentialsPayload): HttpResult {
    return unwrap(httpService.post(`${getBaseUrl()}/user/voice-accesses`, payload));
  }

  updateUserAccess(id: number, payload: VoiceAccessCredentialsPayload): HttpResult {
    return unwrap(httpService.put(`${getBaseUrl()}/user/voice-accesses/${id}`, payload));
  }

  removeUserAccess(id: number): HttpResult {
    return httpService.delete(`${getBaseUrl()}/user/voice-accesses/${id}`);
  }

  // --- TTS / STT ---

  synthesize(accessId: number, text: string, options?: { voice?: string; language?: string; speed?: number; outputFormat?: string }): HttpResult {
    return httpService.post(`${getBaseUrl()}/voice/tts?accessId=${accessId}`, {
      text,
      ...options,
    });
  }

  transcribe(accessId: number, audioFile: File, options?: { language?: string; model?: string }): HttpResult {
    const params = new URLSearchParams();
    params.set('accessId', String(accessId));
    if (options?.language) params.set('language', options.language);
    if (options?.model) params.set('model', options.model);

    const formData = new FormData();
    formData.append('file', audioFile);
    return httpService.post(`${getBaseUrl()}/voice/stt?${params}`, formData);
  }
}

export const voiceService = new VoiceServiceImpl();
