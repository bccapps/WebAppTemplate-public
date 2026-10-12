# Voice Module (Frontend)

## Role
Frontend counterpart of the `nestcommon/voice` module. Provides admin CRUD UI for voice provider catalog and accesses, plus a reusable `VoiceAccessCrud` component for both admin and user contexts.

## Structure

```
voice/
  components/ui/
    AdminConfig.tsx              — Module config form (moduleId="voice")
    AdminVoiceAccesses.tsx       — Admin CRUD for voice accesses
    AdminVoiceProviderCatalog.tsx — Admin CRUD for provider catalog
    VoiceAccessCrud.tsx          — Reusable access CRUD component
  services/
    VoiceService.ts             — HTTP facade (singleton)
    unwrap.ts                   — Response envelope unwrapper
  types/
    index.ts                    — TypeScript interfaces
```

## Services

### VoiceService

| Method | Endpoint | Description |
|--------|----------|-------------|
| `listProviderCatalog()` | `GET /voice-provider-catalog` | List all voice providers |
| `createProviderCatalog(payload)` | `POST /voice-provider-catalog` | Create a provider |
| `updateProviderCatalog(id, payload)` | `PUT /voice-provider-catalog/:id` | Update a provider |
| `removeProviderCatalog(id)` | `DELETE /voice-provider-catalog/:id` | Delete a provider |
| `listAccesses()` | `GET /voice-accesses` | List admin accesses |
| `createAccess(payload)` | `POST /voice-accesses` | Create admin access |
| `updateAccess(id, payload)` | `PUT /voice-accesses/:id` | Update admin access |
| `removeAccess(id)` | `DELETE /voice-accesses/:id` | Delete admin access |
| `listUserAccesses()` | `GET /user/voice-accesses` | List user accesses |
| `createUserAccess(payload)` | `POST /user/voice-accesses` | Create user access |
| `updateUserAccess(id, payload)` | `PUT /user/voice-accesses/:id` | Update user access |
| `removeUserAccess(id)` | `DELETE /user/voice-accesses/:id` | Delete user access |
| `synthesize(accessId, text, options?)` | `POST /voice/tts` | Text-to-speech |
| `transcribe(accessId, audioFile, options?)` | `POST /voice/stt` | Speech-to-text |

## Components

| Component | Description |
|-----------|-------------|
| `AdminConfig` | Renders `<ModuleConfigForm moduleId="voice" />` |
| `AdminVoiceAccesses` | Loads provider catalog, renders `VoiceAccessCrud` with admin API |
| `AdminVoiceProviderCatalog` | Full CRUD for provider catalog with sortable table, capability chips, dialog forms |
| `VoiceAccessCrud` | Reusable CRUD form + table for voice accesses. Supports dynamic `providerConfig` fields (region, projectId) based on provider type. Capability badges per provider. |

## Key Types
- `VoiceCapability` — `'tts' | 'stt' | 's2s'`
- `VoiceProviderCatalog` — Provider entity with capabilities array
- `VoiceAccessCredentials` — Access with provider info, hasPassword flag, providerConfig
- `VoiceAccessCredentialsPayload` — Create/update payload

## Dependencies
- `reactcommon/common` (HttpService, I18n, httpResultToPromise, useSortableTable, ConfigurationService, ModuleConfigForm)
- `reactcommon/common` only (`sessionAuth` for admin checks). No dependency on `reactcommon/user`.
- Icons: `@mui/icons-material` (already a template dependency).

## Admin screens
No front `plugin.tsx`: the `Admin*.tsx` screens (`AdminConfig`, `AdminVoiceAccesses`, `AdminVoiceProviderCatalog`) are auto-discovered as tabs by the common `AdminPage` (`Admin*.tsx` glob), which already handles the admin gate.

## Anonymous mode (no `user` module)
- Admin screens work with the admin key (`sessionAuth` → `adminTokenAuth`).
- The `/user/voice-accesses` routes answer 401 in anonymous mode (nest `RequireUserInterceptor`). Any per-user voice UI built on
  `voiceService.listUserAccesses()` & co must render nothing when `!isUserManagementEnabled()` (import from `common/auth/sessionAuth`).
  This lib ships no such component today (`VoiceAccessCrud` is generic and only used with the admin API here).
