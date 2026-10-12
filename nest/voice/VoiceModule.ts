/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../common/CommonModule';

// Entities
import { VoiceProviderCatalogEntity } from './entities/VoiceProviderCatalogEntity';
import { VoiceAccessEntity } from './entities/VoiceAccessEntity';
import { UserVoiceAccessEntity } from './entities/UserVoiceAccessEntity';

// Services
import { VoiceProviderCatalogService } from './services/VoiceProviderCatalogService';
import { VoiceAccessService } from './services/VoiceAccessService';
import { UserVoiceAccessService } from './services/UserVoiceAccessService';
import { VoiceCatalogSeederService } from './services/VoiceCatalogSeederService';
import { VoiceConfigRegistrarService } from './services/VoiceConfigRegistrarService';
import { VoiceTtsService } from './services/VoiceTtsService';
import { VoiceSttService } from './services/VoiceSttService';
import { VoiceS2sService } from './services/VoiceS2sService';

// TTS clients
import { GoogleCloudTtsClient } from './services/clients/GoogleCloudTtsClient';
import { AmazonPollyClient } from './services/clients/AmazonPollyClient';
import { AzureTtsClient } from './services/clients/AzureTtsClient';
import { ElevenLabsTtsClient } from './services/clients/ElevenLabsTtsClient';

// STT clients
import { GoogleCloudSttClient } from './services/clients/GoogleCloudSttClient';
import { DeepgramSttClient } from './services/clients/DeepgramSttClient';
import { AssemblyAiSttClient } from './services/clients/AssemblyAiSttClient';
import { OpenAiWhisperClient } from './services/clients/OpenAiWhisperClient';

// S2S clients
import { DeepgramS2sClient } from './services/clients/DeepgramS2sClient';
import { ElevenLabsS2sClient } from './services/clients/ElevenLabsS2sClient';
import { GladiaS2sClient } from './services/clients/GladiaS2sClient';
import { OpenAiRealtimeClient } from './services/clients/OpenAiRealtimeClient';

// Controllers
import { VoiceProviderCatalogController } from './controllers/VoiceProviderCatalogController';
import { VoiceAccessController } from './controllers/VoiceAccessController';
import { UserVoiceAccessController } from './controllers/UserVoiceAccessController';
import { VoiceTtsController } from './controllers/VoiceTtsController';
import { VoiceSttController } from './controllers/VoiceSttController';

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([
      VoiceProviderCatalogEntity,
      VoiceAccessEntity,
      UserVoiceAccessEntity,
    ]),
  ],
  providers: [
    // Catalog & access services
    VoiceProviderCatalogService,
    VoiceAccessService,
    UserVoiceAccessService,
    VoiceCatalogSeederService,
    VoiceConfigRegistrarService,
    // Capability services
    VoiceTtsService,
    VoiceSttService,
    VoiceS2sService,
    // TTS clients
    GoogleCloudTtsClient,
    AmazonPollyClient,
    AzureTtsClient,
    ElevenLabsTtsClient,
    // STT clients
    GoogleCloudSttClient,
    DeepgramSttClient,
    AssemblyAiSttClient,
    OpenAiWhisperClient,
    // S2S clients
    DeepgramS2sClient,
    ElevenLabsS2sClient,
    GladiaS2sClient,
    OpenAiRealtimeClient,
  ],
  controllers: [
    VoiceProviderCatalogController,
    VoiceAccessController,
    UserVoiceAccessController,
    VoiceTtsController,
    VoiceSttController,
  ],
  exports: [
    VoiceProviderCatalogService,
    VoiceAccessService,
    UserVoiceAccessService,
    VoiceTtsService,
    VoiceSttService,
    VoiceS2sService,
  ],
})
export class VoiceModule {}
