# Interaction module (back)

> Contrat : `docs/plans/2026-11-09-mcp-access/04-canaux-c0-contrat.md` (projet ChainTradingDataAPI), §20 et §21 prioritaires.
> Côté front : `react/interaction/README.md`. Lot C1 (socle). Licence MIT.

## Rôle

Canaux de notification **par utilisateur** et **questions avec réponse**, pour toute app qui a des comptes :

- `inapp` (notice dans la boîte de l'app + toast / notification du navigateur + modale de question) : **toujours** dans le
  plan, jamais désactivable, repli garanti (invariant 1) ;
- `browser` : Web Push (VAPID, `web-push`) vers les navigateurs abonnés de l'utilisateur ;
- `telegram` : bot propre de l'utilisateur (`own`) ou bot de l'exploitant (`operator`), liaison par `/start <code>`,
  questions en carte à boutons signés ;
- point d'extension pour les canaux de l'app (`email`, `webhook`, `prowl`… : **non livrés** par ce lot).

Une **notice** informe (`notify`), une **question** (`ask`) attend une réponse : première réponse gagnante, refus après
l'échéance, issue remise au gestionnaire de l'app (`onAnswer`) au moins une fois. Aucun texte brut d'outil : le module ne
transporte que le résumé fourni par l'app, caviardé (`maskKnownSecrets`) et tronqué.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `InteractionModule.ts` | `InteractionModule.forRoot(options)` : module **global** (un seul appel, à la racine de l'app). `interactionProviders(options)` / `interactionControllers(options)` (partagés avec la suite de conformité). |
| `plugin.ts` | Fabrique `module: (options) => InteractionModule.forRoot(requirePluginOptions('interaction', options, ['directory']))`, type `InteractionPluginOptions`. |
| `interactionOptions.ts` | `InteractionModuleOptions` (§4.8) : `directory` (obligatoire), `builtIn { browser, telegram }`, `providers`, `imports`, `ports`, `routes { user, admin, telegramWebhook }`, `background`, `allowCodeProof` (défaut `false`, §22), `pushHostAllowlist` (hôtes Web Push en plus de `DEFAULT_PUSH_HOSTS`), `allowAnyPublicPushHost` (défaut `false`). |
| `interactionConfigSchema.ts` | Schéma de configuration (`moduleId: 'interaction'`, clés `interaction_*`). |
| `interactionEntities.ts` | Les 14 entités (`INTERACTION_ENTITIES`). |
| `types/` | `interactionTypes.ts` (vocabulaire, notice, question, billet, issue, rapport), `providerTypes.ts` (point d'extension), `ports.ts` (ports et jetons d'injection). |
| `errors/` | `InteractionError(code, details)`, table des statuts HTTP ; `InteractionHttpException` + `InteractionErrorInterceptor` (corps `{ code, message, details? }`, `Retry-After`). |
| `services/UserInteractionService.ts` | Ce que l'app utilise : `notify`, `notifyMany`, `notifyAdmins`, `ask`, `cancel`, `getTicket`, `onAnswer(kind, handler, { source })`, `answerFromProvider`, `reachableKinds`, `forgetUser`. Le billet rendu par `ask` / `getTicket` (`InteractionTicket`, côté serveur seulement, jamais un DTO) nomme la question qu'il pose (`kind`, `source`, `correlationId`) : un canal `reply` de l'app y applique ses propres règles avant `answerFromProvider` (C2, AgentHub). |
| `services/InteractionDeliveryService.ts` | Algorithme de livraison (§7) : validation, inactif, `inapp`, plan, réservation, plafonds, envoi concurrent sous délai, rapport. `ping()` (envoi de test). |
| `services/InteractionTicketService.ts` | Cycle de vie d'une question (§8) : création, réponse (UPDATE conditionnel), expiration, annulation, remise de l'issue (relances persistées), fermeture des autres surfaces. |
| `services/InteractionChannelService.ts` | Canaux de l'utilisateur (configuration par le fournisseur, interrupteur, ordre, suppression, test) et vue / interrupteur administrateur. |
| `services/InteractionInboxService.ts` | Boîte `inapp` (notices, billets ouverts, lu / non lu). |
| `services/InteractionPrefService.ts` | Préférences (heures calmes, fuseau, `critical_bypass`, routage, affichage). |
| `services/InteractionSendQuotaService.ts` | Plafonds persistés des envois demandés par l'utilisateur (`email_code`, `channel_test`, `link_code`). |
| `services/InteractionProviderRegistry.ts` | Fournisseurs intégrés puis ceux de l'app ; capacité `proof` déclarée et vérifiée au démarrage (`code` refusé sans `allowCodeProof`) ; `enabledKinds()`, `replyKinds()`, `proofOf()`, `answerChannels()`. |
| `services/InteractionRenderer.ts` | Langue du destinataire, traduction (`LocaleService`), URL absolues (`BrandService`). |
| `services/InteractionKeyService.ts` | Clés dérivées de `CRYPT_DB_MASTER_KEY` (HKDF, `info` par usage : `INTERACTION_KEY_INFO`) : signature des boutons Telegram, secret du webhook Telegram. Copie le décodage de la clé maîtresse et du sel de `CryptService` (le lot ne modifie pas `common`) ; `InteractionKeyService.spec.ts` échoue si les deux divergent. |
| `services/InteractionTicketCardStore.ts` | Cartes des canaux `reply` (exporté pour les fournisseurs de l'app). |
| `services/InteractionMaintenanceService.ts` | Workers seulement : balayage d'expiration + relances (`runExclusive('interaction.expire')`), purge quotidienne (`runIfDue('interaction.purge')`). |
| `services/InteractionRuntime.ts` | `InteractionBackground` (travail en arrière-plan suivi), `InteractionSignals` (signaux internes), `InteractionHooks` (`registerRenderHook`). |
| `services/InteractionConfig.ts` | Lecture typée de `interaction_*` (repli sur le défaut du schéma) ; enregistre le schéma au démarrage. |
| `adapters/` | Ports par défaut : `CryptInteractionSecretStore`, `EventStreamRealtime`, `LoggerAuditSink`, `ConfigVapidKeySource`. |
| `providers/browser/` | `BrowserChannelProvider`, `WebPushSender` (via la garde réseau). |
| `providers/telegram/` | `TelegramChannelProvider`, `TelegramBotClient`, `TelegramSender` (file par bot), `TelegramLinkService`, `TelegramBotStateStore`, `TelegramUpdateHandler`, `TelegramBotPoller`, `TelegramBotFleet`, `TelegramInboundRegistry`. |
| `controllers/` | `InteractionMeController`, `InteractionAdminController`, `TelegramWebhookController` ; `interactionRequest.ts` (`RequireHumanSessionInterceptor`). |
| `pure/` | Fonctions pures : textes, validation, plan de livraison, codes, boutons Telegram, mises à jour Telegram, corps HTTP. |
| `utils/` | `maskKnownSecrets.ts`, `netGuard.ts` (garde SSRF extraite d'AgentHub). |
| `dtos/`, `mappers/` | DTO du §11.4, conversions entité → DTO. |
| `testing/` | `interactionConformance.testkit.ts` (suite du §17), `interactionHardening.testkit.ts` (durcissement C1), `interactionConcurrency.testkit.ts` (Postgres seulement), `interactionHarness.ts`, `interactionFakes.ts`, `sqliteEngineEnv.ts`. |
| `locales/interaction.{fr,en}.json` | Libellés de la configuration (`interaction_*`) et textes rendus par le serveur (`interaction.server.*`). |
| `ddl/interaction.{postgres,sqlite}.sql` | DDL de référence des 14 tables (apps en `migrations` / `manual`). |

## Dépendances

- `common` seulement (`module.json` : `requires: ["common"]`, `databases: ["postgres", "sqlite"]`) : `CryptService`,
  `ModuleConfigService`, `ConfigurationService`, `LocaleService`, `BrandService`, `EventStreamService`, `CronLockService`,
  `InstanceRoleService`, `throttledFetch`, `isUniqueViolation`, `jsonColumnType()` / `timestampColumnType()`,
  `RequireUserInterceptor`, `AdminOnlyInterceptor`, `@Public()`, `AppException`. Jamais `vx-private` : l'accès aux comptes
  passe par le port `InteractionDirectory`.
- **npm** : `web-push` (`package.fragment.json`), chargé à la demande au premier envoi Web Push (les clés VAPID sont générées
  par `crypto`, sans la bibliothèque).
- **Environnement** : aucune variable nouvelle ; `CRYPT_DB_MASTER_KEY` (déjà requis par `CryptService`) est obligatoire.
- **Optionnel** : `USER_CONTACT` (`common/types/ExtensionPoints.ts`) pour la langue de l'utilisateur quand l'annuaire n'a pas
  `localeOf`.
- Il faut des comptes utilisateurs (`AuthPort` en mode `users`) : sans eux, les routes `/me` répondent `401`.

## Intégration dans une app (C3)

1. Lier le module (`node scripts/add-module.mjs interaction`, back et front).
2. `back/src/config/pluginOptions.ts` :
   ```ts
   interaction: { directory: AppInteractionDirectory, imports: [UserModule], builtIn: { browser: true, telegram: true } }
   ```
   `AppInteractionDirectory implements InteractionDirectory` (actif, admin, administrateurs, noms, e-mail vérifié, langue).
   Sans plugin : `InteractionModule.forRoot({ … })` **une fois** dans l'`AppModule`. Les consommateurs n'importent jamais le
   module : ils injectent `UserInteractionService`.
3. Appeler `userInteraction.forgetUser(userId)` à la suppression d'un compte.
4. Schéma : `DB_SCHEMA_MODE=sync` crée les tables ; sinon migration propre depuis `ddl/`.
5. Configuration (admin) : `interaction_enabledKinds`, `interaction_telegramMode` (+ jeton de l'exploitant si `operator`),
   `interaction_vapidSubject`.

```ts
constructor(private readonly interaction: UserInteractionService) {
  // Bound to its source: an `ask` of this kind from another module is refused, a ticket of another source never reaches it.
  // The handler still checks the source and the ticket it stored for this approval (idempotent by ticketId).
  interaction.onAnswer('mcp.approval', async (a) => {
    if (a.source !== 'mcp-access') return;
    const approval = await approvals.findByTicket(a.ticketId); // the ticketId stored when `ask` returned
    if (!approval || approval.id !== a.correlationId) return;
    await approvals.decide(approval.id, a.status, a.actionId, a.via, a.answeredBy);
  }, { source: 'mcp-access' });
}
await interaction.notify(ownerId, { type: 'mcp.credential.suspended', source: 'mcp-access', category: 'security',
  title: { key: 'mcp.notice.suspended.title' }, url: `/mcp/credentials/${id}`, dedupKey: `suspended:${id}:${at}` });
const ticket = await interaction.ask(ownerId, { kind: 'mcp.approval', source: 'mcp-access', correlationId: approval.id,
  category: 'approval', summary: { title: { raw: approval.title }, fields: [...] },
  actions: [{ id: 'approve', label: { key: 'mcp.approve' }, style: 'primary' }, { id: 'deny', label: { key: 'mcp.deny' }, style: 'danger' }],
  expiresAt, answerableFrom: ['inapp', 'telegram'] });
```

## Endpoints exposés (exhaustif)

Toutes les routes `/me` : **session utilisateur humaine** seulement, et la règle **échoue fermé** (`RequireUserInterceptor` :
ni `admin-token`, ni `local-trust`, ni clé de service, ni absence de session ; puis `RequireHumanSessionInterceptor` n'admet
qu'un principal `kind: 'user'` portant le marqueur POSITIF `req.user.isHumanSession === true`, jamais un principal marqué
`req.user.isApiToken === true`, ni une requête portant aussi un principal de service ou MCP). **Contrat avec le module
`user` (lot S)** : il pose `isHumanSession` sur les principaux des vraies sessions (`sid > 0`) et `isApiToken` sur les JWT
utilisateur émis comme jetons d'API (`POST /users/admin/:id/api-token`, `aud=api`). Un principal sans l'un ni l'autre (un
`AuthPort` qui ne les pose pas encore) est refusé : **l'adoption (C3) suppose le lot S** ; tout refus est la même `401`.
Un identifiant de chemin d'un
autre utilisateur répond **404** comme un identifiant inconnu. Une erreur qui n'est pas celle du module (base de données…)
répond `500 INTERNAL` (« Internal error »), jamais son message ; elle est journalisée par sa classe / son code. Erreurs :
`{ code, message, statusCode, details? }` (codes ci-dessous). Désactivables par `routes: { user: false, admin: false }`.

| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/interaction/me/channels` | Utilisateur | `inapp` puis chaque `kind` proposé → `InteractionChannelDto[]` (`view` = vue propriétaire, jamais un secret ; `capabilities`, `proof` = `in_app` \| `link` \| `code`, §22). |
| `PUT` | `/api/v1/interaction/me/channels/:kind` | Utilisateur, 10/min | Configure (corps propre au fournisseur, ex. Telegram `{ mode?, token?, inbound? }`) → `InteractionChannelSaveDto` (`secret` non nul **une fois** pour une clé de webhook ; jamais un jeton de bot). `ADMIN_DISABLED`, `KIND_DISABLED`, `INVALID_CONFIG`, `BOT_IN_USE`, `UPSTREAM_UNAVAILABLE`. |
| `PATCH` | `/api/v1/interaction/me/channels/:kind` | Utilisateur | `{ enabled?, position? }` → `InteractionChannelDto` ; réactiver un canal coupé par un admin : `409 ADMIN_DISABLED`. |
| `DELETE` | `/api/v1/interaction/me/channels/:kind` | Utilisateur | Oublie le canal (secret détruit, bot arrêté, liens et abonnements supprimés) → `{ success: true }` ; `409 ADMIN_DISABLED` si coupé par un admin. |
| `POST` | `/api/v1/interaction/me/channels/:kind/verify` | Utilisateur, 10/min | `{ code }` → `InteractionChannelDto` (fournisseurs à vérification ; sinon `VERIFICATION_FAILED { reason: NO_PENDING }`). |
| `POST` | `/api/v1/interaction/me/channels/:kind/test` | Utilisateur, 10/min | Envoi de test (plafonds `channel_test`) → `{ ok, code }`. |
| `POST` | `/api/v1/interaction/me/channels/webhook/secret` | Utilisateur, 10/min | Nouvelle clé d'un fournisseur `webhook` de l'app (`rotateSecret`), montrée une fois → `InteractionChannelSaveDto`. |
| `POST` | `/api/v1/interaction/me/channels/telegram/link-code` | Utilisateur, 10/min | Code de liaison (plafond `link_code`) → `{ code, deepLink, expiresAt }` (`https://t.me/<bot>?start=<code>`, 10 min, usage unique) ; `429 RATE_LIMITED { cap: 'pending' }` si, sous appels parallèles, ce code n'est déjà plus parmi les 5 plus récents. |
| `DELETE` | `/api/v1/interaction/me/channels/telegram/links/:linkId` | Utilisateur | Délie un compte Telegram de l'utilisateur → `InteractionChannelDto`. |
| `GET` | `/api/v1/interaction/me/webpush/public-key` | Utilisateur | `{ publicKey }` (VAPID, généré au premier usage). |
| `POST` | `/api/v1/interaction/me/webpush/subscriptions` | Utilisateur, 10/min | `{ endpoint (https, ≤ 2 048, sans identifiants, sur un service de push connu : `DEFAULT_PUSH_HOSTS` + `pushHostAllowlist`, port par défaut, sauf `allowAnyPublicPushHost`), keys: { p256dh, auth } (base64url, ≤ 256 caractères remplissage compris), userAgent? (≤ 256) }` → `{ success: true }` ; un endpoint déjà enregistré par **un autre** utilisateur ne lui passe qu'avec les **mêmes** `p256dh` et `auth` (preuve du même navigateur : appareil partagé), sinon refus `400 INVALID_INPUT { field: 'endpoint' }` comme un endpoint mal formé ; le sien est renouvelé ; le front (`<InteractionHost />`) désabonne ce navigateur quand l'utilisateur connecté change ; 20 navigateurs au plus par utilisateur (« enregistrer puis compter » : sous appels parallèles, jamais plus de 20, les autres `429 RATE_LIMITED { cap: 'user' }`, jamais une violation d'unicité brute). |
| `DELETE` | `/api/v1/interaction/me/webpush/subscriptions` | Utilisateur | `{ endpoint }` (corps) → `{ success: true }` (le navigateur de l'utilisateur seulement). |
| `POST` | `/api/v1/interaction/me/webpush/subscriptions/remove` | Utilisateur | Même chose en `POST` (le `HttpService` du front n'envoie pas de corps en `DELETE` ; un endpoint ne passe jamais dans une URL). |
| `GET` | `/api/v1/interaction/me/prefs` | Utilisateur | → `InteractionPrefDto`. |
| `PUT` | `/api/v1/interaction/me/prefs` | Utilisateur | `InteractionPrefBody` (champs optionnels) → `InteractionPrefDto` ; `422 ROUTE_REQUIRED` pour un routage `approval` / `security` vide. |
| `GET` | `/api/v1/interaction/me/inbox` | Utilisateur | → `{ tickets (ouverts), notices (non lues hors billets, ≤ 100), unread }`. |
| `GET` | `/api/v1/interaction/me/notices/:id` | Utilisateur | → `InteractionNoticeDto` (404 si pas la sienne). |
| `POST` | `/api/v1/interaction/me/notices/read` | Utilisateur | `{ ids: string[] (≤ 100) }` ou `{ all: true }` → `{ success: true }`. |
| `GET` | `/api/v1/interaction/me/tickets/:id` | Utilisateur | → `InteractionTicketDto` (non destinataire ⇒ 404, identique à un id inconnu). |
| `POST` | `/api/v1/interaction/me/tickets/:id/answer` | Utilisateur, 30/min | `{ actionId, stepUpProof? }` → `InteractionTicketDto` ; `403 CHANNEL_NOT_ALLOWED { required }`, `403 STEP_UP_REQUIRED { methods, purpose }`, `409 ALREADY_ANSWERED { via, at }`, `409 CANCELLED`, `409 ANSWER_REFUSED { reason }` / `409 IN_PROGRESS` (porte de réponse du `kind`), `410 EXPIRED`, `400 INVALID_INPUT`. |
| `GET` | `/api/v1/admin/interaction/channels?userId=&kind=` | Admin (toutes les routes `/admin` : jamais un jeton d'API, `RejectApiTokenInterceptor`, C2) | → `InteractionChannelAdminDto[]` (métadonnées : jamais adresse, URL, `chat_id`, id Telegram, endpoint, jeton). |
| `PATCH` | `/api/v1/admin/interaction/users/:userId/channels/:kind` | Admin | `{ adminDisabled: boolean }` (crée la ligne si absente) → `{ success: true }` ; journalisé sans cible. |
| `GET` | `/api/v1/admin/interaction/telegram/bots` | Admin | → `TelegramBotAdminDto[]` (état de réception, compteurs, `@username`). |
| `POST` | `/api/v1/admin/interaction/telegram/operator/check` | Admin | `getMe` du bot de l'exploitant → `{ ok, botUsername, code }`. |
| `GET` | `/api/v1/admin/interaction/deliveries?userId=&kind=&status=&from=&to=` | Admin | → `InteractionDeliveryAdminDto[]` (codes, jamais de contenu ; 500 au plus). |
| `GET` | `/api/v1/admin/interaction/tickets?status=&source=` | Admin | → `InteractionTicketAdminDto[]` (sans résumé ; 200 au plus). |
| `POST` | `/api/v1/admin/interaction/tickets/:id/cancel` | Admin | `{ reason }` (code court) → `{ cancelled }` ; issue `cancelled` au gestionnaire. |
| `POST` | `/api/v1/interaction/telegram/webhook/:botRef/:botId` | Public (`@Public()`) | Seulement avec `routes.telegramWebhook` **et** `interaction_telegramInbound = webhook` (tous deux coupés par défaut) : `X-Telegram-Bot-Api-Secret-Token` comparé (temps constant) au secret dérivé de `botRef` + `botId` **avant toute lecture de base ou déchiffrement** ; puis le bot doit toujours être `botId` ; sinon `404` identique. Chaque mise à jour est traitée **au plus une fois** : son `update_id` est réclamé dans l'ensemble des mises à jour vues (`interaction_telegram_update`, clé `(bot_ref, update_id)`, INSERT) **avant** le traitement ; une rediffusion est acquittée sans être traitée, une mise à jour plus ancienne arrivée après une plus récente est traitée une fois ; un gestionnaire qui échoue n'est pas relancé (choix assumé : les gestionnaires de messages de l'app ne sont pas idempotents ; un plantage pendant le traitement perd cette mise à jour plutôt que de la traiter deux fois). L'ensemble est gardé 2 jours ; un `message` daté d'avant (rejeu d'un trafic capturé) et une requête sans `update_id` sont acquittés sans traitement. → `{ ok: true }`. |

Temps réel : `GET /api/v1/events/stream?topics=interaction.inbox` (route de `common`) ; événements d'invalidation
`{ type: 'notice' | 'ticket.opened' | 'ticket.closed' | 'channels.changed', id?, data? }`, audience `{ userId }`, sans texte ;
seule une session `kind: 'user'` peut s'abonner au sujet.

Codes d'erreur (§12) : `INVALID_INPUT`, `INVALID_CONFIG { field, reason }`, `VERIFICATION_FAILED { reason }`,
`CHANNEL_NOT_ALLOWED`, `STEP_UP_REQUIRED`, `NOT_FOUND`, `ADMIN_DISABLED`, `KIND_DISABLED`, `NOT_CONFIGURED`, `BOT_IN_USE`,
`ALREADY_ANSWERED`, `CANCELLED`, `EMAIL_UNAVAILABLE`, `EXPIRED`, `ANSWER_REFUSED { reason }` (409, porte de réponse), `IN_PROGRESS` (409), `ROUTE_REQUIRED`, `RATE_LIMITED { cap }` (`user`, `ip`, `target`, `global`, `pending` ; + `Retry-After`),
`UPSTREAM_UNAVAILABLE`, `INTERNAL` (500, toute erreur qui n'est pas celle du module ; le front la lit comme `UNKNOWN`). Levées vers l'app : `INTERACTION_NO_HUMAN`, `INVALID_QUESTION { field }`, `UNKNOWN_QUESTION_KIND`,
`STEP_UP_UNAVAILABLE`, `INVALID_NOTICE { field }`, `SECRET_UNREADABLE`. Codes de remise (`interaction_delivery.code`,
`last_error`) : `DISABLED`, `ADMIN_DISABLED`, `KIND_DISABLED`, `ROUTED_OFF`, `QUIET_HOURS`, `CAPPED`, `NOT_CONFIGURED`,
`NOT_LINKED`, `NO_SUBSCRIPTION`, `TIMEOUT`, `NETWORK`, `HTTP_<statut>`, `ADDRESS_REFUSED`, `REDIRECT_REFUSED`,
`TELEGRAM_<statut>`, `QUEUE_FULL`, `SECRET_UNREADABLE`, `ERROR` — jamais un message libre.

## Livraison (`notify`, §7)

1. Validation (`INVALID_NOTICE`), rendu dans la langue du destinataire, caviardage, coupe (titre 120, corps 1 000).
2. `directory.isActive` faux ⇒ `outcome: 'inactive'`, rien d'autre.
3. `inapp` d'abord, toujours : ligne `interaction_delivery` réservée (`(user, dedupKey, 'inapp')`), notice, événement `notice`.
4. Plan des canaux externes : `kind` proposé, `enabled`, non coupé par un admin, prêt, routage de la catégorie ; ordre :
   `position`, puis `browser`, `telegram`, `email`, `webhook`, puis l'alphabet. Chaque canal non retenu : `skipped` + code.
5. `approval` / `security` jamais muets : si le routage ne retient aucun canal prêt, tous les canaux prêts sont retenus.
6. Heures calmes : `info` seulement (pas `critical` avec `critical_bypass`) ⇒ `skipped QUIET_HOURS`.
7. Réservation (unique `(user_id, dedup_key, kind)`, avant l'envoi : un doublon ⇒ `duplicate`, rien n'est envoyé), puis
   plafonds « enregistrer puis compter » (`interaction_maxPerUserHour`, `interaction_askMaxPerUserHour`,
   `interaction_maxExternalPerHour`) ⇒ `skipped CAPPED`.
8. Envoi : tous les fournisseurs en même temps, chacun sous `AbortSignal` de `interaction_providerTimeoutMs` ; une
   exception ou un délai devient un code (`ERROR`, `TIMEOUT`) sur la ligne et sur le canal (`last_error`), sans retarder
   les autres. Pas de relance automatique.
9. Rapport : `delivered` si au moins un externe `sent`, sinon `inapp_only`.

## Questions (`ask`, §8, §21)

- **Porte de réponse** (C2, `onAnswer(kind, handler, { source, gate })`, `InteractionAnswerGate`, revue humaine requise) : rend les réponses
  d'un `kind` EFFECTIVES et atomiques avec l'état de l'app (un billet n'est jamais `answered` quand l'app refuse la réponse). Ordre : contrôles du
  module → `gate.check` (sans effet : un refus laisse le billet intact et ne dépense aucune preuve) → **réservation** du billet
  (`dispatch_status = 'applying'` jusqu'à `now + timeoutMs + 30 s` ; une réponse concurrente attend 3 s puis `409 IN_PROGRESS` ; le balayage
  d'expiration et `cancel` laissent une réservation vivante) → preuve `freshProof` consommée par le réservataire seul → `gate.apply` (l'effet,
  borné par `timeoutMs`, 30 s par défaut, 120 s au plus ; un refus lève la réservation, billet ouvert, `409 ANSWER_REFUSED { reason: <code> }` —
  une `InteractionError` passe telle quelle, jamais un message ; un dépassement garde la réservation jusqu'à son échéance) → `open → answered`
  lié à la réservation, sans condition d'échéance (l'effet est fait). Un réservataire mort laisse un billet ouvert dont la réservation échoit
  (reprise par la réponse suivante, le balayage ou `cancel`). `openTickets(source, { correlationId?, limit? })` → `[{ ticketId, correlationId,
  applying, recipients }]` (500 au plus) : l'app réconcilie ses billets ouverts avec son état ; `revokeRecipient(source, correlationId, userId,
  reason)` retire un destinataire (ligne, notices, cartes fermées, `ticket.closed` ; billet annulé quand plus personne) : le billet lui devient
  inconnu (`NOT_FOUND`).
- `onAnswer(kind, handler, { source })` : un gestionnaire par `kind` ; `source` lie le `kind` à UNE source : un `ask` de ce
  `kind` venu d'une autre source est refusé (`INVALID_QUESTION { field: 'source' }`), un billet stocké d'une autre source
  n'est jamais remis au gestionnaire (sa remise passe `failed` aussitôt). Le gestionnaire vérifie quand même `a.source` et
  le `ticketId` qu'il a stocké (un `kind` non lié accepte toutes les sources). La liaison n'est **pas une frontière contre
  du code hostile du même processus** : la source est une chaîne qu'un module de l'app peut écrire lui-même (`ask` ou
  `cancel(source, correlationId)` au nom de `mcp-access`) ; elle protège d'une confusion entre modules, pas d'un module
  malveillant.
- `ask(recipients ≤ 20, question)` : validation (`INVALID_QUESTION`), gestionnaire du `kind` requis (`UNKNOWN_QUESTION_KIND`),
  `freshProof` sans port `stepUp` ⇒ `STEP_UP_UNAVAILABLE` ; `(source, correlationId)` existant ⇒ le billet existant ;
  destinataires inactifs filtrés (aucun ⇒ `INTERACTION_NO_HUMAN`). Écrit billet, destinataires, notices `inapp`,
  remises `inapp` (`dedupKey = t:<ticketId>`), publie `ticket.opened`, réserve les canaux externes (`queued`) et **rend la
  main** ; l'envoi externe suit en arrière-plan. Un canal `reply` dans `answerableFrom` reçoit une carte à boutons ; les
  autres une notice avec un lien vers l'app.
- `answerableFrom` : défaut = les canaux `reply` (`inapp`, `telegram`, ceux de l'app) ; une question `freshProof` n'est
  répondable que par les canaux dont la capacité déclarée `proof` est `in_app` (la modale `inapp`, un canal de l'app situé
  dans l'app comme la messagerie d'AgentHub : 04 §22) ; un canal `link` (Telegram, navigateur) n'y reçoit qu'un lien vers
  l'app ; `code` n'y répond jamais en v1.
- Réponse : destinataire (sinon `NOT_FOUND`), destinataire toujours actif (`directory.isActive`, sinon `NOT_FOUND`), canal
  dans `answerableFrom` (`CHANNEL_NOT_ALLOWED`), pour tout canal autre que `inapp` : `kind` proposé (`KIND_DISABLED`), ligne
  du canal de l'utilisateur présente et allumée (`CHANNEL_NOT_ALLOWED { reason: 'CHANNEL_OFF' }`) et non coupée par un
  administrateur (`ADMIN_DISABLED`) — les interrupteurs arrêtent aussitôt les réponses, cartes déjà envoyées comprises ;
  vérifié une première fois puis **de nouveau dans l'UPDATE qui décide** (sous-requête `EXISTS` sur la ligne du canal :
  un interrupteur basculé pendant l'attente d'une réservation ou l'appel au port de step-up bloque encore la réponse) —,
  action connue (`INVALID_INPUT`), puis **un** `UPDATE … SET status='answered', answered_at=:t … WHERE id=? AND
  status='open' AND expires_at > :t`, `:t` lu **à l'instant de cet UPDATE** (jamais avant une étape lente : une réponse
  n'est jamais acceptée après `expires_at`) : un seul gagnant ; les autres reçoivent `ALREADY_ANSWERED`, `EXPIRED` ou
  `CANCELLED`. Chaque réponse (`ticket.answer`) et chaque refus (`ticket.answer_refused`, avec son code) est écrit dans le
  journal d'audit : id du billet, `kind` de la question, source, action, canal, acteur — jamais le texte de la question.
- `answerFromProvider(provider, { ticketId, userId, actionId, stepUpProof? })` : la réponse reçue par un canal `reply` de
  l'app **situé dans l'app** (messagerie d'AgentHub, C2). `provider` doit être l'instance enregistrée pour son `kind`,
  déclarer `proof: 'in_app'` et la capacité `reply` (sinon `CHANNEL_NOT_ALLOWED`) ; ensuite exactement les règles
  ci-dessus (canal de l'utilisateur allumé, preuve d'une question `freshProof` consommée par le seul gagnant, audit) →
  `InteractionTicket`.
- `freshProof` (revue humaine requise) : canal `proof: 'in_app'` (sinon `CHANNEL_NOT_ALLOWED { required }`), preuve fournie
  (sinon `STEP_UP_REQUIRED { methods, purpose }`) ; le billet est d'abord **réservé** par un UPDATE conditionnel
  (`status` reste `open`, `dispatch_status = 'claimed'` pendant 15 s, l'instant de fin servant de jeton) ; seul le
  réservataire appelle `StepUpPort.consume(proofId, 'interaction.ticket:<id>', userId)` (borné à 10 s) ; preuve valide ⇒
  l'UPDATE `open → answered` lié à cette réservation, jugé à l'instant où il s'exécute (une vérification qui déborde
  `expires_at` donne `EXPIRED`, de même qu'une attente de réservation qui la déborde) ; invalide ⇒ réservation levée, billet toujours ouvert,
  `STEP_UP_REQUIRED`. Une réponse concurrente attend la fin de la réservation sans toucher à sa propre preuve (le perdant
  d'une course ne consomme jamais la sienne). Un réservataire mort laisse un billet **ouvert** dont la réservation expire
  (reprise par la réponse suivante ; rien n'est remis au gestionnaire) : jamais de réponse sans preuve consommée. Une
  annulation ou le balayage qui ferment le billet pendant la vérification l'emportent (la preuve, liée à ce billet, est
  alors perdue sans effet). Une transaction autour de l'appel au port a été écartée : SQLite partage une connexion entre
  requêtes concurrentes, et sur Postgres un verrou de ligne tenu pendant l'appel peut épuiser le pool dont le port a
  besoin.
- Issue : remise au gestionnaire en arrière-plan ; échec ⇒ relances persistées (10 s, 1 min, 5 min, 30 min ; au 5ᵉ échec
  `failed` + notice `security` `interaction.dispatch_failed` aux administrateurs) ; au moins une fois (le gestionnaire doit être
  idempotent par `ticketId`), y compris après un redémarrage.
- Fermeture : `ticket.closed` à chaque destinataire, cartes redessinées sans bouton, notices du billet lues ; une réponse
  donnée hors de l'app laisse une notice `security` `interaction.answered_elsewhere` dans la boîte des destinataires — pas
  celle d'un canal dont l'interface est dans l'app (`proof: 'in_app'`, ex. la messagerie d'AgentHub, C2).
- Expiration : refus dès `expires_at` ; balayage (workers, `interaction_expirySweepMs`) ⇒ `expired` remise une fois.

## Telegram (§8.3, §9)

- Modes (`interaction_telegramMode`) : `own` (bot propre : jeton vérifié par `getMe`, refusé s'il sert un autre utilisateur ou
  l'exploitant ⇒ `BOT_IN_USE`, gardé dans le stockage de secrets au nom de l'utilisateur, **jamais** renvoyé), `operator`
  (bot de l'exploitant, `interaction_telegramOperatorBotToken`, secret en écriture seule), `both`, `off`.
- Liaison : code de 32 octets montré une fois, SHA-256 seul stocké, 10 min, usage unique (UPDATE conditionnel), 5 codes en
  attente par (bot, utilisateur) (« enregistrer puis élaguer » : identifiants ordonnés dans le temps, les 5 plus récents
  restent, le plus ancien tombe, même sous appels parallèles), refus `conflict` si le compte Telegram appartient à un
  autre utilisateur (vérifié aussi après l'écriture), 5 comptes par bot propre / par utilisateur sur le bot de
  l'exploitant (« enregistrer puis compter » : sous liaisons parallèles, jamais plus de 5, l'excédent `limit`) ; réponses
  à `/start` plafonnées par bot et par heure. Toute nouvelle liaison émet une notice `security` sur les **autres** canaux
  de l'utilisateur. Un bot propre ne sert qu'un utilisateur : index unique `(kind, external_key)`, deux enregistrements
  simultanés du même bot ⇒ l'un garde le bot, l'autre `BOT_IN_USE` (sans secret conservé). Un jeton donné va toujours dans
  un **nouveau** secret (jamais réécrit sur place) et les liens du bot abandonné (ou du bot de l'exploitant) ne sont
  supprimés qu'après l'écriture : un `BOT_IN_USE` tardif (l'index refuse au moment d'écrire) laisse le canal, le secret et
  les liens du perdant exactement comme avant, et un seul bot interroge le bot disputé.
- Carte : `callback_data = ix:<cardKey 12>:<i>:<mac 8>` (26 octets), `mac` = HMAC-SHA256 de `"ix|" + botRef + "|" + cardKey +
  "|" + i` avec une clé dérivée de `CRYPT_DB_MASTER_KEY`. Un appui n'est accepté que si **tout** tient : signature (avant
  tout accès base), carte ouverte, liaison complète (bot, chat, message, compte Telegram), lien `source: 'code'` qui nomme
  toujours l'utilisateur de la carte, canal Telegram de cet utilisateur allumé, non coupé par un administrateur et dans le
  mode de ce bot (bot de l'exploitant ⇔ `operator`, `u<id>` ⇔ `own`), utilisateur actif ; puis les règles de réponse.
  Sinon : « Ce bouton n'est plus actif »
  (`answerCallbackQuery` toujours appelé), rien d'appris, rien de modifié. Seuls les liens `code` reçoivent des boutons ;
  un lien `declared` / `legacy` reçoit les notices sans bouton.
- Réception : long polling (`getUpdates` 25 s), un poller par bot sur toutes les instances (bail), offset sauvé après chaque
  mise à jour ; bot d'un utilisateur coupé par un admin : jamais interrogé. Webhook optionnel (voir les routes) : le module
  pose `setWebhook(<api>/api/v1/interaction/telegram/webhook/<botRef>/<botId>, <secret du bot>, max_connections: 1)` (une
  mise à jour à la fois, dans l'ordre ; l'ensemble des mises à jour vues accepte de toute façon une plus ancienne arrivée en
  retard, une seule fois).
- `TelegramInboundRegistry` (exporté) : `addCallbackFamily(prefix, handler)` (`ix:` réservé), `addCommandHandler`,
  `setMessageHandler`, `setVoiceHandler`, `onNotificationSent` — seulement pour un expéditeur lié par `/start <code>`
  (pas `declared` / `legacy`), dont l'utilisateur est actif et dont le canal Telegram est allumé, non coupé par un
  administrateur et dans le mode de ce bot (et, pour un bot propre, réception allumée).

## Entités

Toutes portables (Postgres et SQLite : `uuid`, `integer`, `varchar`, `boolean`, `text`, `jsonColumnType()`,
`timestampColumnType()`), sans clé étrangère vers `user` (`forgetUser` à la suppression d'un compte). Nouvelles tables
seulement : `sync` les crée ; sinon `ddl/interaction.postgres.sql` / `ddl/interaction.sqlite.sql`.

| Table | Rôle | Index |
| --- | --- | --- |
| `interaction_user_channel` | Canal configuré d'un utilisateur (`config` non secret, `verification`, `secret_id`, `external_key`, `admin_disabled*`, `last_*`) | unique `(user_id, kind)`, unique `(kind, external_key)` (NULL distincts) |
| `interaction_user_pref` | Préférences (PK `user_id`) | — |
| `interaction_webpush_subscription` | Navigateur abonné (`endpoint` = cible) | unique `endpoint`, `(user_id)` |
| `interaction_notice` | Boîte `inapp` (`title` / `body` en `InteractionText`) | `(user_id, read_at, created_at)` |
| `interaction_delivery` | Journal **sans contenu** et dédoublonnage | unique `(user_id, dedup_key, kind)`, `(user_id, kind, created_at)`, `(kind, created_at)` |
| `interaction_ticket` | Question (`status`, `expires_at`, réponse, `fresh_proof`, `dispatch_*` ; `dispatch_status` : `none`, `claimed` (billet encore ouvert, preuve en vérification), `pending`, `done`, `failed`) | unique `(source, correlation_id)`, `(status, expires_at)`, `(dispatch_status, dispatch_next_at)` |
| `interaction_ticket_recipient` | Destinataires (PK `(ticket_id, user_id)`) | `(user_id)` |
| `interaction_ticket_card` | Carte d'un canal `reply` (`card_key` aléatoire, `binding`, `state`) | unique `card_key`, `(ticket_id)` |
| `interaction_telegram_link` | Compte Telegram lié (`bot_ref`, `source` `code` / `declared` / `legacy`) | unique `(bot_ref, telegram_user_id)`, `(telegram_user_id)`, `(user_id)` |
| `interaction_link_code` | Code de liaison (SHA-256 seul ; `id` ordonné dans le temps) | unique `code_hash`, `(bot_ref)` |
| `interaction_telegram_bot` | État de réception d'un bot (offset, bail, compteurs) | PK `id` (`bot_ref`) |
| `interaction_telegram_update` | Webhook : mises à jour déjà prises (au plus une fois), 2 jours | PK `(bot_ref, update_id)`, `(seen_at)` |
| `interaction_send_counter` | Envois demandés (codes, tests, liaisons), 48 h | `(kind, at)`, `(kind, user_id, at)`, `(kind, ip, at)`, `(kind, target_hash, at)` |
| `interaction_secret` | Secrets (chiffrés par `CryptService`, namespace `interaction:secret:<id>`) | PK `id` |

Rétention (purge quotidienne) : remises 30 j, notices 30 j, billets clos 90 j (avec cartes et destinataires), codes de
liaison 1 j après expiration, compteurs 48 h, mises à jour vues du webhook 2 j.

**Note de migration** (index unique `UQ_ix_user_channel_kind_key (kind, external_key)`, qui remplace l'index non unique
`IDX_ix_user_channel_kind_key`) : sur une base existante, deux lignes d'un même `kind` portant la même `external_key` (un bot
Telegram enregistré par deux utilisateurs avant ce lot) font échouer `synchronize` comme la migration : les résoudre
**avant** (garder la plus ancienne, supprimer les autres avec leur secret), par exemple
`SELECT kind, external_key, count(*) FROM interaction_user_channel WHERE external_key IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`.

## Configuration (`interaction_*`)

`enabledKinds` (`browser, telegram`), `inappDisplayDefault` (`toast`), `defaultTimezone` (`Europe/Paris`),
`maxPerUserHour` (60), `askMaxPerUserHour` (30), `maxExternalPerHour` (0 = aucun), `providerTimeoutMs` (10 000),
`askDefaultTtlSeconds` (300), `askMaxTtlSeconds` (86 400), `expirySweepMs` (30 000), `emailCodesPerUserHour` /
`PerIpHour` / `PerAddressDay` / `GlobalHour` (5 / 10 / 3 / 60), `testsPerUserHour` / `PerIpHour` / `GlobalHour`
(20 / 40 / 300), `linkCodesPerUserHour` (10), `telegramMode` (`own`), `telegramOperatorBotToken` (secret, écriture seule),
`telegramInbound` (`poll`), `telegramMaxUserBots` (50), `telegramStartRepliesPerHour` (20), `linkCodeTtlMinutes` (10),
`emailCodeTtlHours` (24), `vapidPublicKey` / `vapidPrivateKey` (générées, la privée en écriture seule), `vapidSubject`,
`deliveryRetentionDays` / `noticeRetentionDays` / `ticketRetentionDays` (30 / 30 / 90). Lues à chaque usage ; une valeur hors
bornes reprend le défaut. Libellés : `locales/interaction.<lang>.json` (`interaction_<clé>` et `interaction_<clé>_description`).

## Points d'extension

- **Fournisseur de canal** (`InteractionChannelProvider`, `types/providerTypes.ts`) : une classe passée à
  `forRoot({ providers: [MyProvider], imports: [...] })`, son `kind` ajouté à `interaction_enabledKinds`, une carte de
  réglage côté front (`registerInteractionChannelCard`). Il déclare `proof` (04 §22) : `'in_app'` si son interface est dans
  l'app authentifiée (il passe alors `stepUpProof` avec la réponse), `'link'` s'il ne fait que conduire à l'app ;
  `'code'` est refusé au démarrage sauf `forRoot({ allowCodeProof: true })` (et ne répond jamais à une question
  `freshProof` en v1) ; sans déclaration valide, le module ne démarre pas. `externalKey` est unique par `kind` (un conflit
  à l'écriture est `BOT_IN_USE`) et ne doit **jamais être une cible** (adresse e-mail, URL, numéro) : l'index unique ferait
  de `BOT_IN_USE` un oracle disant à un utilisateur qu'un autre a enregistré cette cible. `configure` ne détruit rien :
  ce que le changement abandonne (liens d'un bot précédent…) va dans `afterSave`, exécuté par le module seulement une fois
  la ligne écrite (jamais après un refus : `BOT_IN_USE`, `ADMIN_DISABLED`, une écriture concurrente). Un fournisseur
  `in_app` transmet les réponses par `UserInteractionService.answerFromProvider`.
  `send` ne lève pas (sinon capturé), renvoie un code ; `readiness`
  optionnel (raison du « pas prêt ») ; `rotateSecret` optionnel (clé montrée une fois) ; un fournisseur `reply` écrit ses
  cartes avec `InteractionTicketCardStore`. Libellé du kind : `interaction.channels.<kind>.title` (front de l'app).
- **Ports** (`forRoot({ ports })`) : `secretStore` (`InteractionSecretStore`), `realtime` (`InteractionRealtimePort`), `audit`
  (`InteractionAuditSink`), `stepUp` (`InteractionStepUpPort` : `methods`, `begin`, `complete`, `consume` — implémentation
  `UserStepUpService` du lot S), `vapidKeys` (`VapidKeySource`). `directory` (`InteractionDirectory`) est obligatoire.
- **Services exportés** : `UserInteractionService`, `TelegramInboundRegistry`, `InteractionHooks`
  (`registerRenderHook((ctx) => RenderedMessage)`), `InteractionTicketCardStore`, `INTERACTION_SECRET_STORE`.
- `routes: { user: false, admin: false }` : l'app sert ses propres façades (AgentHub, C2).

## Sécurité (revue humaine requise)

- Aucune cible (adresse, URL, `chat_id`, id Telegram, endpoint) ni secret (jeton, clé, code) dans une vue admin, un journal,
  un événement temps réel ou `interaction_delivery` ; les journaux portent des ids et des codes.
- Secrets : `CryptInteractionSecretStore` échoue fermé (`SECRET_UNREADABLE`, jamais le chiffré), propriétaire vérifié
  (`NOT_FOUND`) ; jeton du bot de l'exploitant et clé VAPID privée en champs `secret` de configuration (écriture seule) ;
  une valeur de configuration qui n'a pas la forme attendue (repli texte clair de `ModuleConfigService`) est refusée.
  L'écriture d'un canal est un compare-and-swap sur `secret_id` : deux configurations concurrentes laissent une ligne
  cohérente et aucun secret orphelin.
- Jeton de bot jamais journalisé : `throttledFetchJson` (de `common`) journalise le message d'un `fetch` en échec ; tous les
  appels de l'API Bot passent par `botApiTransport`, qui remplace toute erreur (undici, polyfill citant l'URL, abandon,
  corps illisible) par un code (`NETWORK`, `TIMEOUT`). `WebPushSender` réduit toute erreur de `web-push` (dont
  `WebPushError`, qui porte l'endpoint et le corps) à `HTTP_<statut>` / `TIMEOUT` / `NETWORK` / un code de la garde.
- Interrupteur administrateur jamais défait par une écriture du propriétaire : `PATCH`, `PUT` (pendant un `getMe`) et
  `DELETE` n'écrivent que leurs colonnes, sous condition `admin_disabled = false` ; et il arrête les réponses (cartes
  Telegram déjà envoyées comprises, modes `own` et `operator`) et les messages / boutons transmis à l'app.
- Erreurs de base de données : jamais renvoyées au client ni journalisées avec leurs paramètres par le module (routes :
  `500 INTERNAL` ; tâches de fond : classe / code seulement) ; les clés Web Push sont bornées à la taille de leur colonne.
- `dedupKey` d'une notice d'app espacé par sa source (stocké `n:` + SHA-256 de la source et de la clé) : la notice d'un
  module ne supprime jamais celle d'un autre ; les billets gardent `t:<ticketId>`.
- Web Push : endpoints sur les services de push des navigateurs (`DEFAULT_PUSH_HOSTS` : `fcm.googleapis.com`,
  `*.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`) + `pushHostAllowlist` ; ailleurs refusé à
  l'abonnement et à l'envoi (`ADDRESS_REFUSED`), sauf `allowAnyPublicPushHost`, et alors avec un `sub` VAPID neutre (URL
  du site, sinon `mailto:webpush@example.invalid`), jamais l'adresse de contact de l'app. Paire VAPID : générée sous verrou
  avec une relecture fraîche de la configuration (le cache de `common` garde 5 s), une deuxième instance ne l'écrase
  jamais.
- Comparaisons à temps constant (signature des boutons, secret du webhook Telegram) ; codes de liaison hachés.
- Garde SSRF (`utils/netGuard.ts`) pour les endpoints Web Push : HTTPS, adresse littérale privée refusée avant, résolution
  contrôlée à la connexion (rebinding compris, IPv6 mappée / traduite SIIT / NAT64 / 6to4), jamais d'adresse privée, pas
  de redirection suivie, URL normalisée passée à `web-push` (même hôte que celui jugé) ; socket borné (`limitSocket` :
  échéance ferme = délai du fournisseur, 64 Kio reçus au plus), car `web-push` accumule toute la réponse et n'a qu'un délai
  d'inactivité.
- Routes `/me` en session utilisateur humaine seulement (jeton d'API refusé) ; `/admin` administrateurs ; webhook Telegram
  `404` uniforme, secret vérifié avant tout accès base, chaque mise à jour traitée au plus une fois.

## Tests

`conformance.sqlite.spec.ts` et `conformance.postgres.spec.ts` exécutent la suite de conformité
(`testing/interactionConformance.testkit.ts`, 22 tests : les 21 du §17 côté back + un parcours HTTP complet ; le test 2 est
côté front). SQLite exige `better-sqlite3` (sinon ignoré) ; Postgres exige `INTERACTION_TEST_PG_URL` vers une base
**jetable** (un schéma par test, supprimé à la fin ; sinon ignoré). Une app peut rejouer la suite avec
`describeInteractionConformance(label, { database })`.

- `testing/interactionHardening.testkit.ts` (`hardening.sqlite.spec.ts`, et `conformance.postgres.spec.ts` pour Postgres) :
  capacité `proof` (liste des canaux, question `freshProof` répondue par un canal `in_app` de l'app avec preuve, jamais
  par un canal `link`), preuve consommée par le seul gagnant (course de deux preuves valides, preuve invalide qui libère
  la réservation, réservataire mort repris, annulation pendant la vérification), premières écritures et plafonds sous
  appels parallèles (abonnements Web Push et plafond de 20, configuration d'un canal et d'un bot propre sans secret
  orphelin, interrupteur administrateur, préférences, codes de liaison), interrupteur administrateur jamais défait par
  `PATCH` / `PUT` / `DELETE` du propriétaire, et un parcours où l'API Bot et le service de push échouent de toutes les
  façons sans qu'un jeton, un secret de webhook, un code de liaison ou un endpoint apparaisse dans un journal, une erreur,
  une ligne d'audit ou une ligne de base.
- `testing/interactionGate.testkit.ts` (`gate.sqlite.spec.ts`, et `conformance.postgres.spec.ts`) : portes de réponse (effet puis billet,
  refus de `check` / `apply` qui laissent le billet ouvert, preuve non dépensée avant tout effet, réponses concurrentes, `IN_PROGRESS`, réservation
  vivante respectée par `cancel` et le balayage même après l'échéance, dépassement, crash puis reprise, `openTickets`, `revokeRecipient`).
  `controllers/interactionControllers.principal.spec.ts` : chaque route d'écriture classée (gardes des contrôleurs).
- `testing/interactionReview.testkit.ts` (`review.sqlite.spec.ts`, et `conformance.postgres.spec.ts` pour Postgres) : les
  constats F1-F9 de la revue indépendante, chaque exploit retourné en test de non-régression (jeton d'API refusé,
  interrupteurs qui arrêtent les réponses et les gestionnaires Telegram en mode `operator`, `kind` lié à sa source,
  réponse jamais acceptée après `expires_at` avec un port de step-up lent, un bot par utilisateur, clés Web Push trop
  longues et erreur de base assainie, webhook (secret avant toute lecture, rediffusion traitée une fois), `dedupKey` par
  source, hôtes de push et `sub` VAPID neutre, endpoint d'un autre utilisateur non repris, 5 comptes par bot, audit des
  réponses, utilisateur désactivé, `answerFromProvider`) ; puis ceux de la deuxième passe : `S1` / `S1b` (`BOT_IN_USE`
  tardif sans demi-état : canal, secret et liens du perdant intacts, un seul bot interroge le bot disputé), `S2`
  (interrupteur basculé pendant le step-up ou après la vérification précoce ⇒ refus à la décision), `S3` (webhook au plus
  une fois, gestionnaire en échec non relancé), `S4` (endpoint déplacé seulement avec les mêmes clés), `F1 / S6` (règle
  fermée : principal sans `isHumanSession` refusé).
- `testing/interactionConcurrency.testkit.ts` (**Postgres seulement**, depuis `conformance.postgres.spec.ts`) : variantes
  parallèles des tests 4, 9, 10, 11, 12, 15, 17 sur un pool de 24 connexions (`trackPoolUsage` prouve que plusieurs
  connexions étaient prises en même temps), plus le bail de réception Telegram, la purge, les types de colonnes, et les
  courses du durcissement (abonnements Web Push et leur plafond, premières écritures dont le bot propre, propriétaire
  contre interrupteur administrateur, codes de liaison, preuves de step-up) et de la revue (même bot par deux utilisateurs,
  5 comptes par bot, rediffusions parallèles d'une mise à jour du webhook). Chaque test boucle
  `INTERACTION_CONCURRENCY_ROUNDS` fois (défaut 5 ; 20 pour une campagne d'endurance).
- `ddl/ddl.postgres.spec.ts` (avec `INTERACTION_TEST_PG_URL`) : le DDL de référence est exactement ce que TypeORM prévoit,
  le DDL **exécuté** sur un schéma vide donne le même catalogue (tables, colonnes, index, contraintes) que `synchronize`
  sur les entités, et TypeORM ne voit plus aucune différence ; `ddl/ddl.sqlite.spec.ts` pour SQLite.
- Sans base : `pure/pure.spec.ts` (fonctions pures), `module.spec.ts` (plugin, locales, caviardage, garde réseau, client
  Telegram, clés dérivées, VAPID), `portableEntities.spec.ts` (types Postgres),
  `services/InteractionKeyService.spec.ts` (équivalence avec `CryptService` : un chiffré de `CryptService` s'ouvre avec la
  clé et le sel décodés par le module, clés hex / base64, avec et sans `CRYPT_DB_DERIVATION_SALT` ; séparation des
  usages ; rotation), `services/InteractionProviderRegistry.spec.ts` (déclaration `proof`, `code` refusé),
  `providers/telegram/TelegramBotClient.spec.ts` (chaque méthode × chaque mode d'échec, aucun jeton, secret ni texte dans
  un journal ou un résultat), `providers/browser/WebPushSender.spec.ts` (erreurs de `web-push` réduites à des codes,
  endpoint jamais cité), `controllers/interactionRequest.spec.ts` (`isHumanSessionRequest` : marqueur positif exigé, jeton
  d'API et identifiants machine refusés), `providers/browser/WebPushSender.real.spec.ts` (la vraie bibliothèque `web-push`, si installée :
  rebinding refusé par l'agent gardé), `adapters/ConfigVapidKeySource.spec.ts` (deux instances, caches périmés, verrou
  non bloquant : une seule paire écrite), `utils/netGuard.spec.ts` (formes d'adresses, identifiants, ports, sockets bornés).
