/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type VoiceCapability = 'tts' | 'stt' | 's2s';

// --- Catalog types ---

export interface VoiceProviderCatalog {
  id: number;
  name: string;
  slug: string;
  type: string;
  capabilities: VoiceCapability[];
  baseUrl: string;
  website: string | null;
  signupUrl: string | null;
  createdAt: string;
}

export interface VoiceProviderCatalogPayload {
  name: string;
  slug: string;
  type: string;
  capabilities: VoiceCapability[];
  baseUrl: string;
  website?: string | null;
  signupUrl?: string | null;
}

// --- Access credentials ---

export interface VoiceAccessCredentials {
  id: number;
  label: string;
  provider: {
    id: number;
    name: string;
    slug: string;
    type: string;
    capabilities: VoiceCapability[];
    baseUrl: string;
    website: string | null;
    signupUrl: string | null;
  } | null;
  baseUrlOverride: string | null;
  username: string | null;
  hasPassword: boolean;
  providerConfig: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceAccessCredentialsPayload {
  label: string;
  providerId: number;
  baseUrlOverride?: string | null;
  username?: string | null;
  password?: string;
  providerConfig?: Record<string, any> | null;
}

export interface VoiceAccessCredentialsResponse {
  accesses: VoiceAccessCredentials[];
}
