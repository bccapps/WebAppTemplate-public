# Voice Module (Backend)

## Role
Provides Text-to-Speech (TTS), Speech-to-Text (STT), and Speech-to-Speech (S2S) services with multiple provider backends. Mirrors the LLM module architecture (ProviderCatalog + Access entities, per-provider client classes, seeder, config schema).

## Architecture

| Layer | Files | Description |
|-------|-------|-------------|
| Entities | `VoiceProviderCatalogEntity`, `VoiceAccessEntity`, `UserVoiceAccessEntity` | Provider catalog, admin accesses, user accesses |
| DTOs | `UpsertVoiceProviderCatalogDto`, `UpsertVoiceAccessDto`, `UserUpsertVoiceAccessDto`, `TtsRequestDto`, `SttRequestDto` | Validation DTOs |
| Services | `VoiceProviderCatalogService`, `VoiceAccessService`, `UserVoiceAccessService` | CRUD services (credentials sealed at rest, see « Chiffrement au repos ») |
| Services | `VoiceSecretCipher`, `voiceSecretReseal` | Encryption at rest of access credentials, legacy plaintext migration |
| Services | `VoiceUserDispatchService`, `voiceUserDispatch` | Dispatch through a USER's own access (ownership, gate, safe target, playable formats) |
| Services | `VoiceTtsService`, `VoiceSttService`, `VoiceS2sService` | Capability dispatch services |
| Services | `VoiceCatalogSeederService`, `VoiceConfigRegistrarService` | Bootstrap services |
| Clients | `GoogleCloudTtsClient`, `AmazonPollyClient` (+ `awsSigV4`), `AzureTtsClient`, `ElevenLabsTtsClient`, `OpenAiTtsClient` | TTS provider clients |
| Clients | `GoogleCloudSttClient`, `DeepgramSttClient`, `AssemblyAiSttClient`, `OpenAiWhisperClient` | STT provider clients |
| Clients | `DeepgramS2sClient`, `ElevenLabsS2sClient`, `GladiaS2sClient`, `OpenAiRealtimeClient` | S2S provider clients (stub) |
| Controllers | `VoiceProviderCatalogController`, `VoiceAccessController`, `UserVoiceAccessController`, `VoiceTtsController`, `VoiceSttController` | REST API |
| Interceptors | `RequireVoiceOwnerInterceptor` | Who may own voice accesses: a user, or the local person of a desktop app that has a `user` row for them |
| Types | `TtsTypes`, `SttTypes`, `S2sTypes`, `VoiceCallParams` | Shared interfaces |

## Dependencies
- `CommonModule` (ModuleConfigService, IdParamDto, `CryptService` for the encryption at rest: **`CRYPT_DB_MASTER_KEY` is required**, it already is for `CommonModule`)
- `CommonModule` only. No dependency on `user`: auth comes from the global interceptor of `common/auth` (`AuthCoreModule`), routes use `AdminOnlyInterceptor`, `RequireAuthInterceptor` and `RequireVoiceOwnerInterceptor` (the user routes).
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
| POST | `/api/v1/user/voice-accesses/:id/tts` | User | Synthesize with one of the caller's own accesses (JSON body `TtsRequestDto`: `text`, `voice?`, `language?`, `speed?`, `outputFormat?`, `gender?`); answers the audio (WAV, or `audio/L16;rate=N;channels=1` for raw PCM), `X-Audio-Duration-Ms` when known |
| POST | `/api/v1/user/voice-accesses/:id/stt?language=&model=` | User | Transcribe with one of the caller's own accesses (raw audio body, WAV recommended); answers `{ data: { text, segments?, language? } }`; no `language` = detection when the provider offers it |
| POST | `/api/v1/voice/tts?accessId=N` | Auth (user or admin-token) | Synthesize text to speech (returns audio binary) |
| POST | `/api/v1/voice/stt?accessId=N` | Auth (user or admin-token) | Transcribe audio to text (raw body upload) |

Errors of the two user dispatch routes: `403` when `voice_allowUserProviders` is off, `404` for an access that does not exist **or belongs to someone else** (same message, ids of others are not revealed), `400` when the provider lacks the capability, the text/audio is too long (`voice_maxTtsChars`, `voice_maxSttDurationMs`; OpenAI TTS: 4096 characters), or the access targets an unsafe URL / region.

Auth column: `Admin` = `AdminOnlyInterceptor`; `User` = `RequireVoiceOwnerInterceptor` (401 in anonymous mode; see « Desktop: the local person owns accesses » below); `Auth (user or admin-token)` = `RequireAuthInterceptor` (in anonymous mode only the `ADMIN_TOKEN` passes).

## Desktop: the local person owns accesses (2026-11-10)
`RequireUserInterceptor` refuses the `local-trust` principal (an administrator with id 0: nobody to own a key). `RequireVoiceOwnerInterceptor`, on the six `/user/voice-accesses` routes, additionally admits a `local-trust` principal **whose id is a positive integer**, which only an app that gave its local person a real `user` row produces (AgentHub desktop: `LocalUserAuthProvider` swaps the id of the anonymous principal for that row's id). The access then belongs to that row (`user_id`), is sealed (`enc:v1:`), checked for ownership and SSRF-guarded exactly like a hub user's. Still refused: an anonymous request, the `ADMIN_TOKEN` identity, and a plain local-trust principal (id 0). A server never runs `LOCAL_TRUST` (it refuses to start on a non-loopback host), so a hub or an app without a local user row behaves as before. Consumers: AgentHub only (VxScore and TradeKong keep their users; none of them runs `LOCAL_TRUST`). Same routes, same response shapes. Also fixed: `POST /user/voice-accesses/:id/tts|stt` handed the dispatch the route id as a string when the app has no global `ValidationPipe({ transform: true })` (AgentHub), which then answered 404 for every access; the id is now converted to a number.

## Entities

### VoiceProviderCatalogEntity (`voice_provider_catalog`)
- `id` (PK), `name`, `slug` (unique), `type`, `capabilities` (simple-array), `baseUrl`, `website`, `signupUrl`, `createdAt`

### VoiceAccessEntity (`voice_accesses`)
- `id` (PK), `label`, `providerId` (FK), `baseUrlOverride`, `username`, `password`, `providerConfig` (JSON portable : `jsonb` sur Postgres, `simple-json` sur SQLite), `createdAt`, `updatedAt`

### UserVoiceAccessEntity (`user_voice_accesses`)
- Same as VoiceAccessEntity + `userId` (plain indexed `user_id` column, **no FK** to `users` since 2026-10: voice must not depend on `user`; users are never hard-deleted, only anonymized), unique constraint on (userId, label)

## Seeded Providers
google-cloud, aws-polly, azure-tts, elevenlabs, deepgram, assemblyai, openai (TTS + STT + S2S), gladia

## User dispatch (`VoiceUserDispatchService`)
Used by the user routes above and by the host apps (AgentHub's `CloudVoicePort`): `synthesize(userId, accessId, request)` and `transcribe(userId, accessId, request)`.
- The access must be the user's (`user_id`), and `voice_allowUserProviders` must be on. Admin accesses keep their own path (`VoiceTtsService` / `VoiceSttService` / `VoiceS2sService`).
- TTS asks each provider for a directly playable format: WAV (Google, Azure) or raw 16-bit PCM tagged `audio/L16;rate=N;channels=1` (Polly 16 kHz, ElevenLabs 16 kHz, OpenAI 24 kHz). The whole buffer is returned (no client streams).
- Voice: the request's `voice`, else `providerConfig.voice`, else a default per provider, language and `gender`. `language` `fr` becomes `fr-FR` for the providers that want a locale.
- **The server calls the provider with the user's key, so the target is constrained**: `baseUrlOverride` must be `https`, a public DNS name (no IP literal, no `localhost`, no `.local` / `.internal` / `.lan` ... suffix, no embedded credentials), and `providerConfig.region` a plain region id. Checked when the access is saved and again before each call. DNS is not resolved: a public name pointing to a private address is not detected.

## Chiffrement au repos des identifiants d'accès
`username` (access key id / account) and `password` (provider key / secret) of `voice_accesses` and `user_voice_accesses` are stored encrypted by `VoiceSecretCipher` on top of `CryptService` (AES-256-GCM, `CRYPT_DB_MASTER_KEY`, optional `CRYPT_DB_DERIVATION_SALT`).
- Stored form: `enc:v1:` + `CryptService.encryptForStorage` payload; namespace `<table>:<field>` (e.g. `user_voice_accesses:password`), authenticated: a value copied to another table or field does not decrypt.
- Text columns, no schema change. `providerConfig` (JSON) is **not** encrypted and must never hold a secret (it carries region, voice, model, engine, instructions).
- Writes seal the new values and any legacy plaintext left on the row. Reads: `getAccessWithSecrets` returns a copy in plaintext for provider calls only (never serialized or logged); a legacy plaintext row stays readable and is **re-encrypted on that read** with a compare-and-set (`UPDATE ... WHERE id = ? AND <field> = <plaintext read>`), so a concurrent save is never overwritten; a failure there is logged (field name) and ignored. Lists (`serialize`) return `hasPassword` and the decrypted `username` (an identifier), never the password.
- Ciphertext that does not authenticate (wrong master key, wrong namespace) makes `getAccessWithSecrets` throw: it is never used as a credential. Changing `CRYPT_DB_MASTER_KEY` therefore makes existing accesses unusable until the keys are typed again.
- Rows never read or saved stay in plaintext: there is no bulk migration (no row is rewritten behind your back).

## Amazon Polly (SigV4) and OpenAI TTS
- `AmazonPollyClient`: `POST https://polly.<region>.amazonaws.com/v1/speech`, signed with `awsSigV4.ts` (hand-written, `crypto` only, header-based `AWS4-HMAC-SHA256`, tested against the AWS documentation example and test-suite vectors; no SDK dependency). `username` = access key id, `password` = secret access key; region from `providerConfig.region` (else the base URL host, else `us-east-1`); optional `providerConfig.engine` (`standard`, `neural`, `long-form`, `generative`) and `providerConfig.voice`. Temporary credentials (session token) are not supported yet. The seeded base URL is `https://polly.{region}.amazonaws.com`.
- `OpenAiTtsClient`: `POST <baseUrl>/audio/speech` with the access key as bearer. Model `gpt-4o-mini-tts` by default (`providerConfig.model` overrides, e.g. `tts-1`); OpenAI announces the shutdown of `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` on 2027-01-06 (replacement: Realtime API, not a drop-in). Voices: `alloy ash ballad coral echo fable nova onyx sage shimmer verse marin cedar` (`tts-1*` only `alloy ash coral echo fable onyx nova sage shimmer`); defaults `coral` (female) / `onyx` (male). Formats: `pcm` (raw 24 kHz 16-bit LE mono), `wav`, `mp3`, `opus`. `providerConfig.instructions` is sent to `gpt-*` models only, `speed` to `tts-1*` only. Input up to 4096 characters.
- Both use plain `fetch` with a 30 s timeout (`throttledFetchJson` only returns JSON, these answer audio).

## Config Schema (`voice` module)
- `voice_defaultTtsAccessId` — Default TTS access ID
- `voice_defaultSttAccessId` — Default STT access ID
- `voice_defaultS2sAccessId` — Default S2S access ID
- `voice_allowUserProviders` — Allow users to add and use their own providers (**default `true`** since 2026-11-09; a value already stored in the config table is kept, an app that wants the old behaviour sets it to `false` in its admin settings)
- `voice_maxTtsChars` — Max characters per TTS request
- `voice_maxSttDurationMs` — Max audio duration per STT request

## Extension Points
- Add new TTS/STT/S2S providers by creating a client class and adding a case to the dispatch service
- S2S WebSocket endpoints planned for phase 2

## Base de données

Les entités utilisent les types de colonnes portables de `common/utils/dbEngine.ts` (`jsonColumnType()`, `timestampColumnType()`), jamais le module `database`. Tests : `sqlite.integration.spec.ts` (SQLite en mémoire) et `portableEntities.spec.ts` (types Postgres inchangés).
