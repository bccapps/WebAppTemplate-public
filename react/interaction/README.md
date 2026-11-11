# Module interaction (front)

> Contre-partie front de `nest/interaction` (`back/.libs/vx-public/nest/interaction/README.md`) : lire ce README avant de
> toucher au module ou de recréer une boîte de notifications dans une app. Contrat : `docs/plans/2026-11-09-mcp-access/04-canaux-c0-contrat.md`
> (§10 front, §11 surface HTTP, §12 codes d'erreur, §21 preuve récente). Lot C1. Licence MIT. Vérifié le 2026-11-10.

## Rôle

Tout ce qu'un utilisateur voit et fait côté navigateur pour les canaux de notification et les questions du module back :

- **notices** reçues en direct (flux `interaction.inbox`) : toast cliquable ou notification native du navigateur ;
- **questions** (tickets) : modale avec résumé, champs, actions, compte à rebours, issue si elles se ferment ailleurs ;
- **boîte** : pastille de compteur pour l'en-tête, liste des questions en attente puis des notices non lues ;
- **réglages** : cartes de canaux (navigateur, Telegram, cartes d'app), préférences (heures calmes, fuseau, contournement
  critique, routage par catégorie, affichage du canal `inapp`) ;
- **administration** : tableau des canaux de tous les utilisateurs (métadonnées seulement, jamais de cible) avec l'interrupteur `adminDisabled` ;
- **Web Push** : abonnement du navigateur et gestionnaires du service worker.

Les textes viennent du serveur sous forme d'`InteractionText` : `{ key, params? }` (clé de traduction, paramètres **nommés** `{nom}`)
ou `{ raw }` (déjà rendu). Ils sont toujours rendus comme du texte, jamais comme du HTML.

Dépendances : module `common` (`HttpService`, `useLiveResource`, `useServerEvents`, `ToastService`, i18n, `sessionAuth`,
`useSortableTable`, plugins). Toutes les URL passent par `configurationService.getApiUrl('interaction')` + `/interaction/me/…`
(utilisateur) ou `/admin/interaction/…` (administrateur).

## Surface publique (`index.ts`)

| Export | Rôle |
|---|---|
| types de `types/interactionTypes.ts` | DTO échangés avec le back (`InteractionTicketDto`, `InteractionNoticeDto`, `InteractionChannelDto`, `InteractionPrefDto`…), `InteractionText`, `INTERACTION_ERROR_CODES`, `InteractionErrorCode` |
| `interactionApi`, `toApiError` | Tous les appels HTTP du module ; `toApiError` transforme une réponse en erreur `{ code, status, details }` |
| `decideInappDisplay`, `displayNotice`, `notificationTag`, `shouldPromptForPermission`, `BrowserPermission`, `NoticeSurface` | Règles pures d'affichage (voir « Permission du navigateur et repli ») |
| `renderText`, `fillParams` | Texte d'un `InteractionText` dans la langue courante, `{nom}` remplis (un paramètre absent reste visible) |
| les hooks et `registerInteractionStepUp` | Voir « Hooks » |
| `interactionStepUpHandler`, `answerWithStepUp`, `stepUpRequestOf` | Pour le canal `reply` d'une app situé dans l'app (04 §22, ex. les cartes de la messagerie d'AgentHub, C2) qui répond par sa propre route : le gestionnaire de step-up enregistré (`null` sans), et le déroulé « sans preuve, puis `STEP_UP_REQUIRED { methods, purpose }` → gestionnaire → avec preuve » |
| `enableWebPush`, `disableWebPush`, `isWebPushSupported`, `requestBrowserPermission` | Côté navigateur (voir « Service worker ») |
| composants | `InteractionHost`, `InteractionQuestionModal`, `InteractionInboxBadge`, `InteractionInboxPanel`, `BrowserNotificationPrompt`, `InteractionChannelsPanel`, `InteractionChannelsAdminPanel`, `InteractionPrefsPanel` |
| `registerInteractionChannelCard`, `InteractionChannelCardProps` | Carte de réglage d'un canal propre à l'app |
| `installInteractionPushHandlers` | À appeler depuis le service worker de l'app |
| `createInteractionPlugin`, `plugin`, `InteractionPluginOptions` | Plugin de l'app |

## Plugin (`plugin.tsx`)

`export const plugin = createInteractionPlugin` (id `interaction`), collecté par `src/plugins.ts` ; aucun fichier de l'app à éditer
pour le brancher. Options (`config/pluginOptions.ts` de l'app ; `false` désactive le plugin) :

| Option | Défaut | Effet |
|---|---|---|
| `host` | `true` | Monte `<InteractionHost />` (Provider du plugin, placement `inner`) |
| `headerBadge` | `true` | Action d'en-tête : `<InteractionInboxBadge />`, visible connecté, qui mène à `path` |
| `routes` | `true` | Page de l'utilisateur à `path` (garde `RequireAuth`) et page admin à `adminPath` (garde `RequireAdmin`), chargées à la demande |
| `path` | `/interaction` | Chemin de la page de l'utilisateur (boîte, canaux, préférences) |
| `adminPath` | `/admin/interaction` | Chemin de la page admin (panneau des canaux) |

Une option du mauvais type, ou un chemin qui n'est pas un chemin d'app (`^/[A-Za-z0-9/_-]*$`), lève une erreur au démarrage.

`<InteractionHost />` n'affiche rien sans utilisateur connecté (`sessionAuth.mode === 'users'`). Il écoute le topic `interaction.inbox` :

- `notice` : lit la notice (`interactionApi.notice`), ignore celles liées à une question (`ticketId`), puis l'affiche selon le
  réglage `effectiveInappDisplay` (toast ou notification native, voir plus bas) ;
- `ticket.opened` : ouvre `<InteractionQuestionModal />` si l'onglet est visible et qu'aucune modale n'est ouverte ;
- `channels.changed` : relit les préférences ;
- à l'ouverture de l'app avec `?interaction=inbox` (lien d'une notification), ouvre la plus ancienne question en attente.

## Hooks (`hooks/interactionHooks.ts`, contrat §10.1)

Les données serveur sont lues en REST et tenues à jour par le flux `interaction.inbox` (`useLiveResource` : invalidations ;
repli sur un sondage de 30 s seulement tant que le flux est indisponible).

```ts
useInteractionInbox(): { tickets: InteractionTicketDto[]; notices: InteractionNoticeDto[]; unread: number; loading: boolean;
                         refetch(): void; markRead(ids: string[] | 'all'): Promise<void> }
useInteractionTicket(id: string | null): { ticket: InteractionTicketDto | null; answer(actionId: string, stepUpProof?: string): Promise<boolean>;
                                           answering: boolean; error: InteractionErrorCode | null; reload(): void }
useInteractionChannels(): { channels: InteractionChannelDto[]; loading: boolean; error: InteractionErrorCode | null;
                            configure(kind, input): Promise<string | null>   // le secret (clé de webhook) n'est rendu qu'une fois
                            setState(kind, { enabled?, position? }): Promise<void>; remove(kind): Promise<void>;
                            test(kind): Promise<{ ok: boolean; code: string | null }>; verify(kind, code): Promise<void>;
                            rotateWebhookSecret(): Promise<string | null>; telegramLinkCode(): Promise<TelegramLinkCodeDto>;
                            unlinkTelegram(linkId): Promise<void>; refetch(): void }
useInteractionPrefs(): { prefs: InteractionPrefDto | null; error: InteractionErrorCode | null; save(patch: InteractionPrefBody): Promise<boolean> }
useInteractionAdminChannels(filter?: { userId?: number; kind?: string }): { rows: InteractionChannelAdminDto[]; loading: boolean;
                                                                            error: InteractionErrorCode | null;
                                                                            setAdminDisabled(userId: number, kind: string, disabled: boolean): Promise<void> }
useBrowserNotificationPermission(): { permission: BrowserPermission; request(): Promise<BrowserPermission> /* depuis un clic seulement */;
                                      dismissed: boolean; dismiss(): void }
useWebPush(): { supported: boolean; subscribed: boolean; busy: boolean; error: string | null /* clé de libellé */; enable(): Promise<void>; disable(): Promise<void> }
```

Écarts avec le contrat §10.1, tels que le code les a : `useInteractionTicket` prend `string | null` (rien n'est lu pour `null`) et `answer`
rend un booléen (`true` si la réponse est partie, `false` sinon : l'erreur est dans `error`, en code) ; `useWebPush().error` est une
clé de libellé `interaction.…`. Les appels de `useInteractionChannels` relancent l'erreur de l'API après avoir relu la liste.

Hooks non exportés par `index.ts` (usage interne) : `useEffectiveInappDisplay`, `webPushErrorLabel`, `INBOX_TOPIC`.

### Point d'extension `registerInteractionStepUp(handler | null)`

```ts
type InteractionStepUpHandler = (request: { ticketId: string; purpose: string; methods: string[] }) => Promise<string | null>;
```

Fournit l'UI qui obtient une preuve récente d'identité (§21). **Le module n'en livre aucune** : elle est implémentée par l'app
(lot S, module `user`). Quand une question exige une preuve fraîche (`freshProofRequired`, avec un `stepUpPurpose`) et que
`answer(actionId)` est appelée sans preuve, le hook appelle le gestionnaire enregistré : l'identifiant de preuve rendu part avec
la réponse ; `null` (l'utilisateur renonce) annule l'envoi sans erreur. Sans gestionnaire, la réponse part sans preuve et le
serveur la refuse (`STEP_UP_REQUIRED`, libellé `interaction.errors.STEP_UP_REQUIRED`). Le dernier enregistrement l'emporte ;
`null` retire le gestionnaire. Le paramètre `methods` est aujourd'hui toujours `[]`.

## Composants

| Composant | Rôle |
|---|---|
| `<InteractionHost />` | Monté par le plugin (voir plus haut) ; à ne monter qu'une fois |
| `<InteractionQuestionModal ticketId onClose />` | Résumé, champs, actions (style `primary` / `danger` / `neutral`), compte à rebours (urgent sous 60 s) ; pendant l'envoi : chargement, fermeture bloquée ; une action non autorisée ici (`allowedHere` faux) est montrée désactivée avec les canaux qui peuvent répondre ; ticket clos ailleurs ou expiré : l'issue remplace les actions. Rendue dans un portail sur `document.body` |
| `<InteractionInboxBadge onOpen? />` | Compteur (questions ouvertes + notices non lues, « 99+ » au-delà) pour l'en-tête |
| `<InteractionInboxPanel />` | Questions en attente (clic : modale) puis notices, « tout marquer lu » |
| `<InteractionChannelsPanel />` | `inapp` toujours présent et non désactivable, puis une carte par canal de la liste : carte enregistrée (`registerInteractionChannelCard`) en priorité, sinon carte intégrée (`browser`, `telegram`), sinon le cadre commun (`ChannelCardFrame` : état, interrupteur, test, suppression) ; un canal `adminDisabled` est expliqué et non modifiable |
| `<InteractionChannelsAdminPanel />` | Tableau triable (`useSortableTable`) type / propriétaire / état / vérifié / dernier test / dernière erreur, interrupteur `adminDisabled` |
| `<InteractionPrefsPanel />` | Heures calmes, fuseau, `criticalBypass`, routage par catégorie (`approval` et `security` : au moins un canal, sinon `ROUTE_REQUIRED`), affichage `toast` / `browser` |
| `<BrowserNotificationPrompt />` | Invite « Activer les notifications du navigateur » : seulement si l'affichage voulu est `browser`, la permission `default` et l'invite non écartée |

Les pages du plugin (`components/InteractionPages.tsx`) assemblent : utilisateur = boîte + canaux + préférences ; admin = panneau
des canaux. `<BrowserNotificationPrompt />` n'est pas dans ces pages : à placer par l'app où elle le souhaite.

**Déroulé d'une réponse `freshProof`** : `answerWithStepUp` (`pure/stepUp.ts`) envoie d'abord la réponse sans preuve ; si le serveur répond `STEP_UP_REQUIRED { methods, purpose }`, il appelle le gestionnaire enregistré avec ces `methods` et ce `purpose`, puis renvoie la réponse avec la preuve (jamais deux demandes). Si l'utilisateur renonce, rien n'est envoyé ; sans gestionnaire (`useHasInteractionStepUp()` faux), la modale désactive les actions et affiche `interaction.modal.stepUpUnavailable`.

**Hôte (`InteractionHost`)** : à la reconnexion / `resync` du flux (`useInboxStream`), il recharge la préférence d'affichage et relit la boîte ; si aucune modale n'est ouverte et que l'onglet est visible, il ouvre la plus ancienne question ouverte **non encore vue dans cet onglet**. Au montage, les questions déjà en attente sont marquées vues (pas de pop-up à chaque rechargement) ; `?interaction=inbox` ouvre la plus ancienne. Les liens d'une notice passent par le routeur de l'app (`useNavigate`) quand l'hôte est dans un routeur, sinon `window.location.assign` ; seuls les chemins relatifs sont acceptés (`pure/navigation.ts`).

### Registre des cartes de canal

```ts
registerInteractionChannelCard(kind: string, component: ComponentType<{ channel: InteractionChannelDto; onChanged: () => void }>): void
```

Carte de réglage d'un fournisseur de l'app (`email`, `webhook`…, dont le back est dans l'app). À appeler une fois au démarrage
de l'app, avant l'affichage du panneau ; le dernier enregistrement d'un `kind` l'emporte. Le titre du canal vient de
`interaction.channels.<kind>.title` (à fournir par l'app pour un `kind` à elle ; `email` et `webhook` ont déjà un titre ici).

## Permission du navigateur et repli sur le toast (§10.4)

`decideInappDisplay(wanted, permission)` (pure) rend `'native'` **seulement** si l'affichage voulu est `browser` et la permission
`granted` ; dans tous les autres cas (`default`, `denied`, `unsupported`, affichage `toast`) `'toast'`. `displayNotice(wanted, input, surface)`
applique la règle : natif d'abord, puis repli silencieux sur le toast si l'envoi natif n'a pas pu se faire (aucun service
worker prêt et pas d'API `Notification`, refus, exception). `browserSurface(showToast)` (dans `browser/browserNotifications.ts`)
est la surface réelle : `registration.showNotification` quand un service worker est prêt, sinon `new Notification`.

- Le `tag` est stable par cible (`notificationTag` : `vx-interaction:<url>` ou `vx-interaction:<id>`) : une répétition remplace
  la précédente, en natif comme en toast.
- Le toast est `toastService.notice({ id: tag, level, title, body, hint: { key: 'interaction.notice.openHint' }, onOpen })`
  (module `common`) : un clic ouvre le lien de la notice (chemin d'app relatif seulement) puis ferme le toast. Niveau :
  `info` → info, `approval` → warning, `security` → error.
- La permission n'est demandée que depuis un clic (`request()`, bouton de l'invite, bouton de la carte `browser`).
- Le choix « ne plus proposer » est gardé dans `localStorage` (`vx.interaction.browserPromptDismissed`, accès sous `try/catch` :
  sans stockage, il dure jusqu'au rechargement).

## Service worker et Web Push (§10.5)

- `enableWebPush()` : service worker prêt, permission (demandée si `default`), clé publique `GET /me/webpush/public-key`,
  `pushManager.subscribe`, puis `POST /me/webpush/subscriptions` ; lève `UNSUPPORTED`, `PERMISSION_DENIED` ou `INVALID_SUBSCRIPTION`.
  `disableWebPush()` ne lève jamais (désabonne puis `POST …/subscriptions/remove`, l'endpoint dans le corps). `useWebPush()` les enveloppe.
- **Fin de session** : `<InteractionHost />` appelle `useWebPushSessionGuard(user?.id ?? null)` (il est déjà re-rendu par
  `useSessionKeys(['user'])`) : quand l'utilisateur connecté change (déconnexion, fin de session, autre compte), l'abonnement
  Web Push de ce navigateur est annulé (`disableWebPush()` ; l'appel `remove` refusé après la déconnexion est sans effet, le
  service de push répond ensuite `410` au back, qui supprime la ligne). Règle pure : `webPushActionOnSessionChange` /
  `createWebPushSessionTracker` (`pure/webPushSession.ts`). Une app qui ne monte pas `<InteractionHost />` doit appeler
  `disableWebPush()` à la déconnexion (avant d'effacer la session, pour que le back le sache aussi). Un rechargement de page
  ne désabonne rien. Côté back, un endpoint enregistré par un autre utilisateur ne passe à celui-ci qu'avec les mêmes clés
  `p256dh` / `auth` (même navigateur).
  Sans PWA (pas de `serviceWorker` ou de `PushManager`) : `isWebPushSupported()` est faux et la carte `browser` se limite aux
  notifications à onglet ouvert.
- `sw/interactionPush.ts` : `installInteractionPushHandlers(scope, { fallbackTitle? })` pose `push` (affiche `title`, `body`, `tag`,
  `data.url` ; charge utile illisible : titre de repli `Notification` par défaut) et `notificationclick` (ferme la notification,
  focalise un onglet de l'app et le fait naviguer, sinon `clients.openWindow` ; **chemin de même origine seulement**, `/` sinon).
  Le fichier n'a aucune dépendance DOM ni React (le worker le charge dans son bundle) ; `scope` est décrit par l'interface
  minimale `InteractionWorkerScope`.

**À ajouter par l'app (C3)** : dans son `sw.ts` (PWA), importer le fichier par chemin direct (pas par `index.ts`, qui tire React)
et l'appeler, par exemple `installInteractionPushHandlers(self as unknown as InteractionWorkerScope)` avec
`import { installInteractionPushHandlers, type InteractionWorkerScope } from '@/modules_shared/interaction/sw/interactionPush'`.
Le gabarit n'ajoute pas encore cet import : sans lui le canal `browser` fonctionne à onglet ouvert seulement.

## Styles et jetons de thème

Le module charge `styles/tokens.css` (jetons, défauts en `:where(:root)`, seul endroit à valeurs) et `styles/interaction.css`
(classes `.ix-*`, qui ne lisent que des jetons : aucune couleur littérale). Les défauts lisent le contrat `common/theme/tokens.css`
(`--color-*`) ; un thème les surcharge, jamais un composant. Le fond de la modale est `--common-sharedui-backdrop-bg` (existant, module `common`).

| Jeton | Usage |
|---|---|
| `--interaction-modal-bg` / `-fg` / `-border` | Modale de question |
| `--interaction-action-primary-bg` / `-fg` | Bouton d'action de style `primary` |
| `--interaction-action-danger-bg` / `-fg` | Bouton d'action de style `danger` |
| `--interaction-action-neutral-bg` / `-fg` | Bouton d'action de style `neutral` |
| `--interaction-countdown-fg` | Compte à rebours |
| `--interaction-countdown-urgent-fg` | Compte à rebours sous 60 s |
| `--interaction-badge-bg` / `-fg` | Pastille de compteur de la boîte |
| `--interaction-inbox-item-bg` | Ligne de la boîte |
| `--interaction-inbox-item-unread-bg` | Ligne non lue, et invite de permission |
| `--interaction-channel-card-bg` / `-border` | Carte de canal |
| `--interaction-channel-state-ok-fg` | État prêt |
| `--interaction-channel-state-error-fg` | État en erreur, erreurs de formulaire, action destructive |
| `--interaction-channel-state-off-fg` | État inactif ou non configuré |
| `--interaction-muted-fg` | Textes secondaires et aides |
| `--interaction-category-security-fg` / `-approval-fg` / `-info-fg` | Étiquette de catégorie |

Le toast cliquable (`toastService.notice`) n'a pas de jeton ici : ses styles (`.vx-toast-notice*`) sont dans
`common/components/ui/toast/ToastZone.css` et reprennent la couleur du toast.

## Libellés (i18n)

`locales/locales.en.json` et `locales.fr.json` (mêmes clés ; les libellés du module vivent ici, jamais dans `common.*.json`). Familles :

`interaction.page.*`, `.notice.*` (`openHint`), `.modal.*` (dont `outcome.<answered|expired|cancelled>`), `.inbox.*`, `.categories.<security|approval|info>`,
`.prompt.*`, `.channels.*` (communs : état, test, suppression, enregistrement ; `.state.*`, `.inapp.*`, `.browser.*` dont `permission.<état>` et `pushError.*`,
`.telegram.*` dont `mode.<own|operator>`, `.email.title`, `.webhook.title`), `.prefs.*`, `.admin.*` (dont `columns.*`), `.errors.<CODE>` (un par code de
`INTERACTION_ERROR_CODES`, plus `UNKNOWN` ; `ANSWER_REFUSED` et `IN_PROGRESS` depuis C2 : porte de réponse du `kind`). Une clé manquante s'affiche telle quelle (pas de valeur par défaut). Un nouveau `kind` d'app
ajoute `interaction.channels.<kind>.title` dans les libellés de l'app.

## Fichiers

| Chemin | Rôle |
|---|---|
| `index.ts`, `plugin.tsx`, `module.json` | Surface, plugin, métadonnées (requiert `common`) |
| `types/interactionTypes.ts` | DTO et codes d'erreur (miroir du back, sans logique) |
| `services/interactionApi.ts`, `services/labels.ts` | Appels HTTP ; `ixLabel` (libellé en texte pour un attribut) |
| `hooks/interactionHooks.ts` | Hooks et `registerInteractionStepUp` |
| `pure/` | `inappDisplay.ts`, `text.ts`, `channelState.ts` : règles sans `window` |
| `browser/browserNotifications.ts` | Permission, choix « ne plus proposer », notification native, Web Push |
| `browser/webPushSession.ts` | `useWebPushSessionGuard` : l'abonnement Web Push suit l'utilisateur connecté (règle pure `pure/webPushSession.ts`) |
| `components/` | Hôte, modale, boîte, panneaux, pages, registre et cartes de canal (`channels/`) |
| `sw/interactionPush.ts` | Gestionnaires du service worker |
| `styles/`, `locales/` | Jetons et classes ; libellés en et fr |

Côté `common` (additif, 04 §10.3) : `toastService.notice(...)` dans `common/core/toast/ToastService.ts`, styles dans `ToastZone.css`.

## Tests

Vitest en environnement `node` (le projet n'a ni jsdom ni Testing Library : pas de test de rendu navigateur ; les composants
ne sont pas testés ici). Depuis `front/` une fois le module lié, `npx vitest run` (config du projet, `vitestConfig.ts`) ; avant la
liaison, avec une config hors dépôt : `createVitestConfig({ include: ['.libs/vx-public/react/interaction/**/*.spec.ts', '.libs/vx-public/react/common/core/toast/*.spec.ts'] })`.

| Spec | Couvre |
|---|---|
| `plugin.spec.ts` | Options, parties activables, chemins invalides, collecte sous l'id `interaction` |
| `hooks/stepUpRegistry.spec.ts` | `interactionStepUpHandler` : le dernier enregistré, `null` une fois retiré |
| `pure/inappDisplay.spec.ts`, `pure/text.spec.ts` | Décision natif / toast, repli, tag, invite ; textes, compte à rebours, `safeAppPath`, état d'un canal |
| `services/interactionApi.spec.ts` | URL, corps et conversion des erreurs |
| `sw/interactionPush.spec.ts` | Gestionnaires `push` et `notificationclick` |
| `locales/locales.spec.ts` | Parité en / fr, toute clé littérale des sources existe, un libellé par code d'erreur et par famille dynamique |
| `common/core/toast/ToastService.spec.ts` | `toastService.notice` : mise à jour par `id`, clic → `onOpen`, indice, texte par `toastNoticeText` (react-toastify simulé) |

Avant un commit : `npm run typecheck:specs`, `npm run i18n:check`, `npm run theme:check` (`--libs` pour contrôler les modules liés).
