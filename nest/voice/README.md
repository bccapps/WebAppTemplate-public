# Voice Module (Backend)

## Role
Provides Text-to-Speech (TTS), Speech-to-Text (STT), and Speech-to-Speech (S2S) services with multiple provider backends. Mirrors the LLM module architecture (ProviderCatalog + Access entities, per-provider client classes, seeder, config schema).

## Architecture

| Layer | Files | Description |
|-------|-------|-------------|
| Entities | `VoiceProviderCatalogEntity`, `VoiceAccessEntity`, `UserVoiceAccessEntity` | Provider catalog, admin accesses, user accesses |
| DTOs | `UpsertVoiceProviderCatalogDto`, `UpsertVoiceAccessDto`, `UserUpsertVoiceAccessDto`, `TtsRequestDto`, `SttRequestDto` | Validation DTOs |
| Services | `VoiceProviderCatalogService`, `VoiceAccessService`, `UserVoiceAccessService` | CRUD services |
| Services | `VoiceTtsService`, `VoiceSttService`, `VoiceS2sService` | Capability dispatch services |
| Services | `VoiceCatalogSeederService`, `VoiceConfigRegistrarService` | Bootstrap services |
| Clients | `GoogleCloudTtsClient`, `AmazonPollyClient`, `AzureTtsClient`, `ElevenLabsTtsClient` | TTS provider clients |
| Clients | `GoogleCloudSttClient`, `DeepgramSttClient`, `AssemblyAiSttClient`, `OpenAiWhisperClient` | STT provider clients |
| Clients | `DeepgramS2sClient`, `ElevenLabsS2sClient`, `GladiaS2sClient`, `OpenAiRealtimeClient` | S2S provider clients (stub) |
| Controllers | `VoiceProviderCatalogController`, `VoiceAccessController`, `UserVoiceAccessController`, `VoiceTtsController`, `VoiceSttController` | REST API |
| Types | `TtsTypes`, `SttTypes`, `S2sTypes`, `VoiceCallParams` | Shared interfaces |

## Dependencies
- `CommonModule` (ModuleConfigService, IdParamDto)
- `CommonModule` only. No dependency on `user`: auth comes from the global interceptor of `common/auth` (`AuthCoreModule`), routes use `AdminOnlyInterceptor`, `RequireAuthInterceptor` and `RequireUserInterceptor`.
- `voice/plugin.ts` exports `plugin: NestModulePlugin` (`id: 'voice'`) so the app imports the module through the generated plugins file.

## Endpoints (exhaustive)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/voice-provider-catalog` | Auth (user or admin-token) | List all voice providers |
| POST | `/api/v1/voice-provider-catalog` | Admin | Create a voice provider |
| PUT | `/api/v1/voice-provider-catalog/:id` | Admin | Update a voice provider |
| DELETE | `/api/v1/voice-provider-catalog/:id` | Admin | Delete a voice provider |
| GET | `/api/v1/voice-accesses` | Admin | List all admin voice accesses |
| POST | `/api/v1/voice-accesses` | Admin | Create an admin voice access |
| PUT | `/api/v1/voice-accesses/:id` | Admin | Update an admin voice access |
| DELETE | `/api/v1/voice-accesses/:id` | Admin | Delete an admin voice access |
| GET | `/api/v1/user/voice-accesses` | User | List user's voice accesses |
| POST | `/api/v1/user/voice-accesses` | User | Create a user voice access |
| PUT | `/api/v1/user/voice-accesses/:id` | User | Update a user voice access |
| DELETE | `/api/v1/user/voice-accesses/:id` | User | Delete a user voice access |
| POST | `/api/v1/voice/tts?accessId=N` | Auth (user or admin-token) | Synthesize text to speech (returns audio binary) |
| POST | `/api/v1/voice/stt?accessId=N` | Auth (user or admin-token) | Transcribe audio to text (raw body upload) |

Auth column: `Admin` = `AdminOnlyInterceptor`; `User` = `RequireUserInterceptor` (401 in anonymous mode); `Auth (user or admin-token)` = `RequireAuthInterceptor` (in anonymous mode only the `ADMIN_TOKEN` passes).

## Entities

### VoiceProviderCatalogEntity (`voice_provider_catalog`)
- `id` (PK), `name`, `slug` (unique), `type`, `capabilities` (simple-array), `baseUrl`, `website`, `signupUrl`, `createdAt`

### VoiceAccessEntity (`voice_accesses`)
- `id` (PK), `label`, `providerId` (FK), `baseUrlOverride`, `username`, `password`, `providerConfig` (jsonb), `createdAt`, `updatedAt`

### UserVoiceAccessEntity (`user_voice_accesses`)
- Same as VoiceAccessEntity + `userId` (plain indexed `user_id` column, **no FK** to `users` since 2026-10: voice must not depend on `user`; users are never hard-deleted, only anonymized), unique constraint on (userId, label)

## Seeded Providers
google-cloud, aws-polly, azure-tts, elevenlabs, deepgram, assemblyai, openai, gladia

## Config Schema (`voice` module)
- `voice_defaultTtsAccessId` — Default TTS access ID
- `voice_defaultSttAccessId` — Default STT access ID
- `voice_defaultS2sAccessId` — Default S2S access ID
- `voice_allowUserProviders` — Allow users to add their own providers
- `voice_maxTtsChars` — Max characters per TTS request
- `voice_maxSttDurationMs` — Max audio duration per STT request

## Extension Points
- Add new TTS/STT/S2S providers by creating a client class and adding a case to the dispatch service
- S2S WebSocket endpoints planned for phase 2
