# Issue report module (back)

## Rôle

Permet aux **utilisateurs connectés** d'une appli de signaler un problème ; le back de l'appli relaie chaque
signalement à un projet **Agent Hub** (entrée publique du hub, `POST <ISSUE_HUB_URL>/issues`) avec le **jeton secret du
projet**, qui ne quitte jamais le serveur de l'appli. Le module suit ensuite l'état des signalements ouverts (tâche
planifiée toutes les 15 min) et, à la clôture, envoie **un seul e-mail** au déclarant (corrigé / laissé tomber / clos)
avec `EmailService` de `common`.

Données personnelles : le hub ne reçoit qu'une référence opaque du déclarant (l'id du principal), le titre, la
description, la page (sans query ni fragment), la version et le navigateur. L'adresse e-mail reste dans l'appli : elle
est lue au moment de l'envoi par le point d'extension `USER_CONTACT` (fourni par le module `user`), jamais stockée ni
journalisée par ce module.

Contrat HTTP du hub : `docs/plans/2026-10-27-issue-review/contracts.md` (§3) du dépôt Agent Hub. Côté front :
`react/issue-report/README.md`.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `IssueReportModule.ts` | Module Nest (`CommonModule` + `TypeOrmModule.forFeature([IssueReportEntity])`). Pas de `ScheduleModule.forRoot()` : l'appli l'enregistre une fois. |
| `plugin.ts` | `{ id: 'issue-report', module: IssueReportModule }` (`NestModulePlugin`, câblage automatique par `plugins.generated.ts`). |
| `controllers/IssueReportController.ts` | Les trois routes ci-dessous. |
| `services/IssueHubClient.ts` | Relais vers le hub par `throttledFetchJson` (`common/utils/throttledFetch.ts`) : `config()` / `isConfigured()` (lecture de `ISSUE_HUB_URL` / `ISSUE_HUB_TOKEN`, relue si l'environnement change), `createIssue(payload)` (POST, **une seule tentative** : un POST rejoué pourrait créer deux issues ; 10 s), `statusOf(numbers)` (GET, ≤ 100 numéros, 2 reprises sur 429/5xx, 1 s entre deux appels). Ne lève jamais ; `null` quand le hub n'est pas lisible. Fonctions pures exportées : `readIssueHubConfig(env)`, `parseHubIssueStatus(entry, asked)`. |
| `services/IssueReportService.ts` | `isEnabled()`, `create(principalId, body, userAgentHeader)`, `mine(principalId)` ; `relayFailure(reason)` (échec du relais → exception HTTP). |
| `services/IssueReportStatusService.ts` | Tâche `@Cron('0 */15 * * * *')` (`issue-report-status`) : `handleCron()`, `hasWork()`, `syncOnce()`. |
| `services/IssueReportNotificationService.ts` | E-mail de clôture : `notifyPending()`, `notify(report)`, `compose(report, languages)` ; `languageOf(code)`. |
| `issueReportInput.ts` | Validation et normalisation côté serveur de chaque champ (`normalizeIssueReportInput`, `normalizeTitle`, `normalizeDescription`, `normalizePageUrl`, `normalizeAppVersion`, `normalizeUserAgent`, `IssueReportInputError`). |
| `issueReportTypes.ts` | Statuts, motifs de clôture, bornes, constantes de lot, types `IssueReportView` / `HubIssueStatus`. |
| `entities/IssueReportEntity.ts` | Table `issue_report`. |
| `dtos/` | `CreateIssueReportDto` (corps du POST, `class-validator`), `IssueReportDto`, `IssueReportCreatedDto`, `IssueReportConfigDto`. |
| `mappers/IssueReportMapper.ts` | `toIssueReportDto(entity)` (sans `userId` ni `notifiedAt`). |
| `locales/issue-report.{fr,en}.json` | Textes de l'e-mail de clôture (clés `issueReport.email.*`, français en « tu »). |

## Dépendances

- `common` seulement (`module.json` : `requires: ["common"]`, `databases: ["postgres", "sqlite"]`) : `EmailService`,
  `EmailLayoutService`, `LocaleService`, `ConfigurationService` (`localeDefault`), `CronLockService`,
  `InstanceRoleService`, `throttledFetch`, `RequireUserInterceptor`, `authUserId`, `@Public()`, `AUTH_PORT`.
- **Optionnel** : `USER_CONTACT` (`common/types/ExtensionPoints.ts`), injecté en `@Optional()`, fourni globalement par le
  module privé `user` (`UserContactModule`). Sans lui : aucun e-mail (un avertissement journalisé une fois), les
  signalements et leur suivi marchent.
- Il faut des **comptes utilisateurs** (module `user` ou tout `AuthPort` en mode `users`) : sans eux, `config` répond
  `enabled: false` et le POST répond `401` (`RequireUserInterceptor`).
- Aucune dépendance npm propre (pas de `package.fragment.json`) ; `@nestjs/schedule` vient du `package.base.json`.

## Endpoints exposés (exhaustif)

| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/issue-reports/config` | Public (`@Public()`) | `{ enabled }` : vrai quand `ISSUE_HUB_URL` et `ISSUE_HUB_TOKEN` sont réglés et valides **et** que l'appli a des comptes (`AUTH_PORT.mode === 'users'` ; sans port d'auth, la garde de route décide). Rien d'autre (ni URL ni jeton). |
| `POST` | `/api/v1/issue-reports` | Utilisateur connecté (`RequireUserInterceptor` : ni clé admin ni mode local de confiance) | Corps `{ title, description, pageUrl?, appVersion? }` (`CreateIssueReportDto`) → `201 { number }` (numéro de l'issue sur le hub). Relais : `reporterRef` = id du principal (jamais une valeur du corps), `userAgent` = en-tête `User-Agent` (≤ 300), `appVersion` = `APP_VERSION` du back s'il est défini, sinon celle du corps. Erreurs (`AppException`, `{ code, message, statusCode }`) : `400 IRP_INVALID` (champ invalide, ou refusé par le hub), `429 IRP_RATE` (10 signalements par utilisateur et par heure glissante, ou débit du hub), `503 IRP_OFF` (module non configuré), `502 IRP_HUB` (hub injoignable, jeton refusé, réponse inattendue). |
| `GET` | `/api/v1/issue-reports/mine` | Utilisateur connecté (`RequireUserInterceptor`) | Les signalements de l'utilisateur, plus récents d'abord, 50 au plus : `IssueReportDto[]` = `{ id, number, title, status: 'open' \| 'closed', closedReason: 'fixed' \| 'dropped' \| 'manual' \| null, closedAt, createdAt }` (dates ISO). |

Validation (`issueReportInput.ts`, indépendante du `ValidationPipe` de l'appli, qui peut être absent ou en mode
validation seule) : `title` chaîne, une ligne (contrôles et blancs répétés → une espace), 3 à 200 caractères après
`trim` ; `description` chaîne, CRLF → LF, caractères de contrôle autres que tabulation et saut de ligne retirés, 1 à
10 000 caractères ; `pageUrl` facultative, URL absolue `http(s)` ou chemin commençant par `/` (pas `//`), ≤ 2 000
caractères bruts, **query, fragment et identifiants retirés**, ≤ 500 après coup ; `appVersion` facultative,
`[A-Za-z0-9_.+-]`, ≤ 64. Les champs inconnus sont ignorés. Bornes alignées sur l'entrée du hub (§3 du contrat).

## Tâche planifiée et e-mail de clôture

- `IssueReportStatusService.handleCron()` toutes les 15 min : rien sur un processus `api` (`InstanceRoleService.isWorker()`),
  ni si le hub n'est pas configuré, ni s'il n'y a **ni signalement ouvert ni avis de clôture en attente** (`hasWork()`,
  avant toute prise de verrou). Sinon `CronLockService.runIfDue('issue-report-status', 14 min)` (une seule instance) puis
  `syncOnce()` : les signalements `open` (1 000 au plus, plus anciens d'abord) sont demandés au hub par lots de 100
  (`GET …/issues/status?numbers=`) ; une issue `closed` passe la ligne à `closed` (`closedReason` : `fixed`, `dropped`,
  sinon `manual` ; `closedAt` du hub, sinon maintenant). Hub illisible : on s'arrête, la prochaine passe réessaie. Un
  signalement fermé n'est plus suivi (une réouverture sur le hub n'est pas reflétée).
- Puis `IssueReportNotificationService.notifyPending()` (100 au plus par passe) : sans fournisseur `USER_CONTACT`, ou avec
  `common_email_provider = none`, rien n'est envoyé (avertissement une fois par processus, les lignes restent en attente
  et partiront quand la configuration le permettra). Sinon, pour chaque ligne : **prise** atomique
  (`UPDATE … SET notified_at = now WHERE id = ? AND notified_at IS NULL` ; deux passes ne l'envoient jamais deux fois),
  adresse par `USER_CONTACT.emailOf(userId)` (compte actif seulement ; pas d'adresse ⇒ la ligne reste prise, rien à
  envoyer), langue `localeOf(userId)` → `localeDefault` → `en` (une langue sans les clés passe à la suivante), e-mail
  dans la coquille `EmailLayoutService.wrap()` (texte échappé) + version texte. Échec d'envoi : la prise est relâchée pour
  la passe suivante, abandon après 3 tentatives par processus. Les journaux ne contiennent que le numéro de l'issue.

## Entités

`IssueReportEntity` → table `issue_report` (Postgres et SQLite, dates `timestampColumnType()`) :

| Colonne | Type | Rôle |
| --- | --- | --- |
| `id` | uuid (PK, généré) | |
| `user_id` | varchar(64) | id du principal (texte) |
| `hub_number` | int | numéro de l'issue dans le projet du hub |
| `title` | varchar(200) | copie du titre (liste « Mes signalements » sans appel au hub) |
| `status` | varchar(6), défaut `open` | `open` \| `closed` |
| `closed_reason` | varchar(12), null | `fixed` \| `dropped` \| `manual` |
| `closed_at` | timestamptz / datetime, null | |
| `notified_at` | timestamptz / datetime, null | avis de clôture traité (envoyé ou sans adresse) |
| `created_at` | timestamptz / datetime | |

Index : `IDX_issue_report_user_created` (`user_id`, `created_at`), `IDX_issue_report_status`, `IDX_issue_report_hub_number`.
La description n'est pas stockée dans l'appli. Nouvelle table : `DB_SCHEMA_MODE=sync` la crée ; aucune migration.

## Variables d'environnement (`module.json`, ajoutées à `back/.env.example`)

| Variable | Rôle |
| --- | --- |
| `ISSUE_HUB_URL` | URL d'entrée du projet sur le hub, telle qu'affichée par la carte « Signalements de l'appli » des réglages du projet Agent Hub (`https://<hub>/api/v1/issue-intake`). `http(s)` sans identifiants, query ni fragment ; `http` hors boucle locale ⇒ avertissement (le jeton circulerait en clair). |
| `ISSUE_HUB_TOKEN` | Jeton d'entrée du projet (`ahi_…`, montré une seule fois par le hub). Secret : uniquement dans l'environnement du back (`back/.env` / secrets du déploiement), jamais dans un `VITE_*`, jamais renvoyé au front, jamais journalisé. |

Les deux vides : module inerte (`enabled: false`, aucune tâche). Une seule réglée ou valeur invalide : inerte + un
avertissement au démarrage (sans le jeton). `APP_VERSION` (de `common`) alimente `appVersion` quand il est défini.

## Intégrer le module dans une appli

1. `node scripts/add-module.mjs issue-report` depuis la racine du projet : ajoute `issue-report` aux listes back et
   front de `shared-modules.json`, régénère `.env.example` (les deux variables), `package.json` et les liens
   `modules_shared`. Aucun fichier de code de l'appli n'est modifié (plugins `plugin.ts` / `plugin.tsx`).
2. Dans Agent Hub, réglages du projet → « Signalements de l'appli » : activer, générer le jeton, copier les deux lignes
   dans l'environnement du back de l'appli (`ISSUE_HUB_URL=…`, `ISSUE_HUB_TOKEN=…`).
3. L'appli doit avoir le module `user` (comptes ; il fournit aussi `USER_CONTACT` pour l'e-mail) et un fournisseur
   d'e-mail configuré (`common_email_provider`). Retrait : `node scripts/add-module.mjs --remove issue-report` (la table
   reste en base).

## Points d'extension

- Consomme `USER_CONTACT` (`UserContactProvider { emailOf(userId), localeOf?(userId) }`, `common/types/ExtensionPoints.ts`)
  en `@Optional()`.
- Exporte `IssueReportService` (un module de l'appli peut créer un signalement côté serveur avec `create(principalId, body, userAgent)`).

## Tests

`issueReportInput.spec.ts` (validation), `services/IssueHubClient.spec.ts` (relais : URL, méthode, Bearer, une seule
tentative, codes, jeton jamais journalisé), `services/IssueReportService.spec.ts` (503/400/429/502, `reporterRef` du
principal, ligne gardée), `services/IssueReportStatusService.spec.ts` (aucun appel sans signalement ouvert, clôtures,
lots, gardes de la tâche), `services/IssueReportNotificationService.spec.ts` (envoi unique, sans fournisseur, échecs,
langue, adresse jamais journalisée), `controllers/IssueReportController.http.spec.ts` (pipeline Nest réel : public,
401 sans session / clé admin, identité du corps ignorée), `sqlite.integration.spec.ts` (requêtes réelles sur SQLite,
nécessite `better-sqlite3`), `portableEntities.spec.ts` (types Postgres).
