# Common module

This module contains common services and utils used by other modules.

## Configuration
In tsconfig.app.json, add the following in the compiler options :
    /* Path Resolution */
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
In vite.config.ts, add the following :
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },


In App.tsx :
import { PreloaderGate } from '@/modules_shared/common/core/preload/PreloaderGate';

Then embed everything in the PreloaderGate with the needed services :
    <PreloaderGate
    services={[configurationService, localeService, userService]}
    >
        {children}
    </PreloaderGate>

### Loading order — two waves, not fully serial
`Preloader.load()` (`core/preload/Preloader.ts`) resolves `ConfigurationService` alone
first (`add()` always `unshift`s it to the front for this reason), then starts every
other registered service's `init()` **in parallel** — the other services only ever read
config values ConfigurationService sets up, they aren't dependencies of each other
(PERFORMANCE_PLAN.md §1.1). `ready()`/`nb_loaded()`/the single `ready` event stay
correct under concurrent completions (see `Preloader.spec.ts`). If your app doesn't pass
a `ConfigurationService`, everything just loads in parallel from the start.

**Background services** — `preloader.addBackground(service)` (`PreloaderGate` prop `background`, normally fed by `buildPreloadPlan`
from the plugins' `preload: [{ ..., mode: 'background' }]`): started with the second wave, never awaited by `ready()`.

**Keep barrier-blocking services to the strict minimum.** Only put a service in the
`PreloaderGate`/`AppPreloaderGate` `services` array if something renders incorrectly
without its data. `CryptService` in particular should NOT be listed — it self-heals
lazily (`ensureSession()` runs on every wrapped request via `HttpService`), so blocking
the whole app on its handshake buys nothing; call `cryptService.init()` yourself in a
background effect instead (fire-and-forget, its own `init()` never rejects). A service
whose reads are used synchronously by a handful of call sites (e.g.
`BlockchainIndicatorService.getAvailable()`) can similarly be started in parallel with
`ConfigurationService`'s wave-2 batch or right after it resolves, and expose a
`whenReady(): Promise<void>` so only the call sites that actually need the data await
it — see `blockchainIndicator/services/BlockchainIndicatorService.ts` for the pattern
(promise memoized, resolved on both the success AND the failure path so a network error
never hangs a caller forever).

---

## `utils/environment.ts` — détection de l'environnement courant (2026-09-08)

`isProductionEnvironment()` / `currentEnvironmentLabel()` lisent `import.meta.env.VITE_APP_ENV` (variable Vite, définie au build par app — `VITE_APP_ENV=production` en prod, `preprod`/`dev` sinon). **La valeur "prod" côté front est la string `'production'`**, différente de la valeur backend `process.env.APP_ENV === 'prod'` (voir `nestcommon/common/utils/CrossEnvDbConnection.ts#assertProductionEnvironment` côté backend) — ne pas confondre les deux. Utilisé par `EnvBadge.tsx` (app-level, badge d'environnement du header) et par chaque module exposant une copie de données prod→preprod — nommé `AdminCopyProdToPreprod.tsx` par convention (celui du module `cms`, celui du module `workshop` app-level) — pour désactiver leur bouton hors production — un confort d'UX uniquement, la vraie barrière est le garde `assertProductionEnvironment()` côté backend.

---

## `utils/preloadReload.ts` — rechargement unique après un déploiement

Un onglet ouvert avant un déploiement peut demander un chunk lazy que le nouveau déploiement a supprimé : Vite émet alors
`vite:preloadError`. `installPreloadErrorReload({ target, storage, reload, schedule? })` (appelé par `main.tsx` du gabarit avec
`window`, `sessionStorage` et `window.location.reload`) recharge **une seule fois** pour récupérer le nouvel `index.html`.
Garde anti-boucle : la clé `vite-preload-reloaded` de `sessionStorage` (`claimPreloadReload` / `releasePreloadReload`) ; elle est
effacée 5 s après un chargement sans erreur, pour que le déploiement suivant ait sa propre tentative. Stockage indisponible
(mode privé) : pas de rechargement (pas de boucle possible). Tests : `utils/preloadReload.spec.ts`.

## PWA — `pwa/` (installation de l'application)

`pwa/hooks/usePwaInstallPrompt.ts` (`canInstall`, `isIos`, `isInstalled`, `prompt`) et `pwa/types.ts` (`PwaConfig`). Le gabarit
branche le hook sur `PwaInstallButton` (bouton facultatif de l'en-tête, copié seulement si le projet active la PWA). La
configuration du plugin Vite, le service worker (jamais de cache de `/api/`) et les options de l'assistant sont décrits dans
`template/README.md` (« Front public files and PWA »).

## `HttpService` — déduplication des requêtes en vol (opt-in)

Depuis PERFORMANCE_PLAN.md §6.3/§2.2 b, `HttpService.get/post/put/patch/delete/gets` acceptent une
option `{ dedupe: true }` (`HttpRequestOptions.dedupe`, `core/http/HttpService.ts`) : quand un second
appel avec la **même clé** (méthode + URL + corps sérialisé JSON) est fait pendant qu'un appel
identique est encore en vol, il **réutilise la même exécution** au lieu de tirer une seconde requête
HTTP. L'entrée est retirée du registre (`Map` privée `inFlightRequests`) à la résolution, succès
**comme** échec — un appel ultérieur repart toujours d'une requête fraîche.

- **Opt-in strict, jamais une heuristique sur le verbe** : `HttpService` ne peut pas savoir si un
  `POST` donné a des effets de bord ou non (ex. `seriebyday-batch` est un POST mais un pur read).
  Ne passez `dedupe: true` que sur un appel dont vous savez qu'il est sûr à partager entre plusieurs
  appelants — jamais sur une mutation (create/update/delete). Sans l'option, le comportement est
  strictement inchangé (passthrough direct vers `runRequest`).
- **Chaque appelant reçoit son propre `HttpResult`**, avec ses propres callbacks
  (`.then()/.error()/.fail()/.notAuthorized()`) — la promesse axios partagée en interne est un
  `Promise` natif, et un `Promise` fan-out nativement vers tous ses `.then()/.catch()` attachés ; il
  n'y a pas de plomberie supplémentaire à écrire côté appelant.
- **Interaction avec le rafraîchissement de token** : le retry-sur-401 de `runRequest` (voir
  `setTokenRefresher`) se rejoue via un appel direct à `runRequest` (pas re-dédupliqué), donc il
  s'exécute **à l'intérieur** de la promesse partagée avant qu'elle ne se résolve — une entrée
  dédupliquée ne reste jamais bloquée sur la tentative 401 initiale, tous les appelants reçoivent le
  résultat de la tentative rejouée.
- Utilisation actuelle : `blockchainIndicator/services/BlockchainIndicatorService.ts`
  (`getSerieByDay`, `getSerieByDayBatch`) — deux composants demandant la même série au même instant ne
  tirent qu'une requête. Voir `core/http/HttpService.spec.ts` pour les cas testés (dedupe par défaut
  désactivé, opt-in GET/POST, clé différente = pas de partage, purge sur succès/échec, interaction
  401).

## `HttpService` — détection globale du mode maintenance (2026-09-26)

`setGlobalMaintenanceHandler(handler: (active: boolean) => void)` (`core/http/HttpService.ts`), même
principe que `setGlobalUnauthorizedHandler` pour les 401 : `handler(true)` est appelé dès qu'une
réponse porte le marqueur `503` + corps `{ maintenance: true }`, `handler(false)` au prochain succès
(2xx) — sur **n'importe quel** appel déjà en cours, il n'y a pas d'endpoint dédié interrogé en
continu. Ce marqueur est produit par le reverse-proxy `back-lb` (nginx) quand son fichier
`/etc/nginx/maintenance.flag` existe — voir `deploy-full.sh`/`deploy_back_host()` côté apptemplate,
qui le pose avant d'arrêter `back`/`back-worker` et le retire une fois le nouveau `back` `healthy`,
sans jamais fermer le port public. N'appelle jamais le handler à la place de `.error()/.fail()` du
`HttpResult` de l'appel concerné — celui-ci continue de recevoir son callback normalement, le
handler global est un signal **en plus**, pas un remplacement. Consommateur type : un composant
app-level monté une fois (ex. `MaintenanceOverlay`) qui écoute un event DOM déclenché par ce handler
depuis `main.tsx` et affiche un écran plein écran tant que `active === true`.

## `HttpService.upload` — envoi multipart avec progression

`httpService.upload(url, formData, { headers?, onProgress?, signal?, skipTransport?, withCredentials? })` renvoie un `HttpResult`
comme `post` (`.then/.fail/.error/.notAuthorized`). Il passe par le même chemin que les autres appels : jeton d'API enregistré pour
le préfixe de l'URL, sinon Bearer en mémoire, session de transport, rafraîchissement préventif et un rejeu sur 401 (le rejeu renvoie le
même `FormData`). `headers` s'ajoute à la requête (un `Authorization` explicite l'emporte sur le jeton enregistré) ; ne pas fixer
`Content-Type` (le navigateur ajoute la frontière multipart). `onProgress({ loaded, total, percent })` reçoit la progression réelle
(`percent` vaut `null` tant que le total est inconnu, `toUploadProgress`) ; `signal` annule la requête. Pas de déduplication.
Remplace les intercepteurs axios temporaires des apps (ex. `postFormData` de ComptaFacile). Tests : `core/http/HttpService.spec.ts`.

## Coquille de bureau — `useDesktopDownloads`

Dans l'application de bureau (`template/desktop/`), le navigateur embarqué ne montre rien quand un `<a download>` aboutit : la
coquille enregistre le fichier dans le dossier Téléchargements puis déclenche sur `window` l'événement `desktop-download`
(`detail: { path, success }`). `useDesktopDownloads(onDownload?)` (`hooks/useDesktopDownloads.ts`) l'écoute et, par défaut, affiche
un toast `ToastService` (succès : `common.desktop.download.saved` / `savedIn` avec le nom du fichier ; échec : `failed` / `failedFile`,
clés fr + en dans `locales/`). À monter **une fois** dans la mise en page de l'application ; sans coquille (navigateur) l'événement
n'est jamais émis, le hook est inerte. Tant qu'il est monté il pose `window.__desktopHandlesDownloads = true`, ce qui supprime la
notification de secours de la coquille. Un `onDownload` personnalisé remplace le toast.

La logique pure (`parseDesktopDownload`, `downloadFileName`, `toDownloadToast`, `subscribeDesktopDownloads`, constantes
`DESKTOP_DOWNLOAD_EVENT` et `DESKTOP_HANDLES_DOWNLOADS_FLAG`) est dans `core/desktop/desktopDownloads.ts` (sans dépendance React) ;
le nom de l'événement et du drapeau est à garder identique à `downloads.rs` de la coquille. Tests : `core/desktop/desktopDownloads.spec.ts`.

## Transport chiffré — `CryptService`

`CryptService` (`services/CryptService.ts`) négocie une session AES-256-GCM (ECDH P-256) avec le
backend et déchiffre transparemment les réponses de `HttpService` (`core/http/HttpService.ts`) dès
qu'une session de chiffrement est active — voir le README du module `common` back
(`back/src/modules_shared/common/README.md`) pour le détail des endpoints (`CryptController`) et de
l'interceptor (`TransportCryptInterceptor`).

### Compression avant chiffrement (compress-then-encrypt)
Depuis PERFORMANCE_PLAN.md §2.3, le backend peut deflater le JSON avant de le chiffrer (un ciphertext
base64 étant incompressible, gzip ne peut plus rien faire une fois chiffré). Ce bundle négocie cette
capacité et gère les deux versions du format de payload :

- **Négociation** : `HttpService.runRequest` appelle `cryptService.getTransportCapabilityHeaders()` et
  envoie l'en-tête `x-crypt-accept-encoding` sur chaque requête chiffrée — `'deflate'` si
  `typeof DecompressionStream !== 'undefined'`, sinon `'identity'`. Absence de l'en-tête = comportement
  legacy (pas de session active).
- **Décompression** : `decryptTransport` (privé) détecte le nombre de segments du payload (`:`-séparés)
  pour distinguer `v1` (4 segments, legacy, jamais compressé) de `v2` (5 segments,
  `version:flag:iv:cipher:tag`) et, si `flag` indique `deflate`, décompresse via
  `DecompressionStream('deflate')` (format zlib/RFC1950 — l'exact pendant de `zlib.deflateSync` côté
  Node, **pas** `'deflate-raw'`/RFC1951 ni `'gzip'`/RFC1952).
- **Compatibilité montante/descendante** : les deux versions de payload sont acceptées en déchiffrement
  (`TRANSPORT_PAYLOAD_VERSION` = `v2` courant, `TRANSPORT_PAYLOAD_VERSION_LEGACY` = `v1`), pour qu'un
  bundle en cache navigateur continue de fonctionner contre un backend déjà mis à jour, et vice versa.
- Ces constantes (`crypt.constants.ts`) doivent rester octet-pour-octet synchronisées avec leur copie
  `nestcommon` — ne pas les modifier d'un seul côté.

---

## Flux d'événements — `core/events/`

Client React du flux SSE serveur (`GET /api/v1/events/stream`, voir « Flux d'événements serveur » dans
`nest/common/README.md` pour le format des trames, les sujets et les audiences). Remplace le polling : le serveur
publie des **invalidations**, le client relit par REST.

- **`useServerEvents(topics, handler)`** : appelle `handler(event)` pour chaque événement des sujets tant que le
  composant est monté. Le handler peut changer à chaque rendu sans réabonnement.
- **`useLiveResource(fetcher, { topics, match?, fallbackPollMs, refetchOnResync? })`** : charge `fetcher()`, relit sur
  événement correspondant (relectures regroupées sur 250 ms, jamais deux lectures simultanées), relit sur `resync`,
  au retour de visibilité de l'onglet et à la sortie du mode `fallback`, et **interroge toutes les `fallbackPollMs`**
  tant que le flux est en `fallback`. Renvoie `{ data, loading, error, refetch, streamState }`.
- **`eventStreamClient`** (singleton, `EventStreamClient`) : une seule connexion par onglet. `subscribe(topics, handler,
  { onResync? })` compte les abonnements par sujet et les regroupe (50 ms) ; la connexion est rouverte quand
  l'ensemble des sujets change. `getState()` / `onStateChange()` : `connecting | open | fallback`.

```tsx
// Liste relue sur chaque changement ; polling toutes les 10 s seulement si le flux est indisponible.
const { data: runs, loading } = useLiveResource(() => fetchRuns(), {
  topics: ['tradingbot.runs'],
  fallbackPollMs: 10_000,
});

// Réaction directe à un événement (progression), sans relecture.
useServerEvents([`ocr.document:${companyId}`], (event) => {
  if (event.type === 'status') setStatus(event.data?.['ocrStatus'] as string);
});

// Un seul document : ne relire que pour le bon identifiant.
useLiveResource(() => fetchRun(id), {
  topics: [`tradingbot.run:${id}`],
  match: (e) => e.id === id,
  fallbackPollMs: 5000,
});
```

Comportement du client :

- **Authentification** : `HttpService.streamGet(url, { signal, headers })` (`fetch` + `ReadableStream`, `EventSource`
  ne sait pas envoyer `Authorization`) applique les règles de jeton de `streamFetch` (jeton API par préfixe,
  rafraîchissement préventif, un nouvel essai sur 401), sans chiffrement de transport. L'erreur `StreamHttpError`
  porte `status`. `HttpService.onTokenRefreshed(listener)` notifie chaque rafraîchissement réussi : le flux ouvert
  est alors rouvert avec le nouveau jeton.
- **Session** : l'événement `user` de `appSession` passant à `null` ferme le flux (pas de reconnexion) ; un changement
  d'identité (`id`) le rouvre sans `Last-Event-ID`. L'URL est `getApiUrl()` + `/events/stream`.
- **Reconnexion** : 1 s, 2 s, 4 s ... plafonnée à 30 s, facteur aléatoire +-20 % (`computeBackoff`), `Last-Event-ID`
  renvoyé, valeur `retry:` du serveur respectée. Trame `expired` : reconnexion immédiate avec jeton rafraîchi (comptée
  comme un échec si le flux a duré moins de 5 s). Trame `resync` : `onResync` des abonnés.
- **`fallback`** : après 3 échecs consécutifs, sur 404 (module absent côté serveur : définitif jusqu'au prochain
  changement de session) et tant que le serveur annonce un transport `degraded` (Redis injoignable). Les tentatives
  continuent en arrière-plan après 3 échecs ; `ready` remet l'état à `open`.
- **Analyseur SSE** maison (`SseParser`, `readSse`) : lignes multiples, commentaires, `id`, `event`, `retry`,
  terminateurs `\n`, `\r`, `\r\n` coupés n'importe où.
- **Sujets refusés** : le champ `denied` de `ready` est exposé par abonné : option `onDenied(denied)` de `subscribe`
  (appelée à chaque changement, `[]` quand il disparaît ; vidée à la déconnexion de session) et
  `getDeniedTopics(topics)`. Un sujet refusé ne reçoit jamais d'événement : `LiveResourceController`/`useLiveResource`
  interrogent alors la ressource toutes les `fallbackPollMs`, même flux `open`, et s'arrêtent dès que plus aucun de ses
  sujets n'est refusé (pas d'interrogation si `fallbackPollMs` vaut 0).

Tests : `sseParser.spec.ts`, `EventStreamClient.spec.ts`, `liveResourceController.spec.ts` (logique des hooks, sans
DOM) et la section `streamGet` de `core/http/HttpService.spec.ts`.

---

## `ConfigurationService` / `LocaleService` — idempotent `init()`

Both services guard `init()` with a `loaded` flag + a shared in-flight promise:
a call while a load is already pending piggybacks on it (no second HTTP request), and
a call after the first load resolves its callback immediately. This matters because an
app can legitimately call `init()` twice — e.g. `main.tsx`'s `RootGate` loads config to
decide whether to show a landing page, then the `PreloaderGate`/`AppPreloaderGate`
mounted by `<App/>` loads it again (PERFORMANCE_PLAN.md §1.4). Without this, the second
`init()` would re-fetch `/configurations`/`/locales` from scratch.

`LocaleService.init()` additionally only fetches the **active** language (`?lang=`) —
not every configured language upfront (PERFORMANCE_PLAN.md §1.3). The active language is
`i18n.getLang()` (a persisted choice or server-seeded default) or, on a first-ever visit,
the browser's language. Switching language later (`SwitchLanguage`) calls
`localeService.ensureLangLoaded(lang)` before `i18n.setLang(lang)` — a no-op if that
language's payload was already loaded (at boot or by a previous switch), otherwise it
fetches it on demand. Module-local locales (`src/modules_shared/**/locales/locales.*.json`,
bundled at build time via `import.meta.glob`) are unaffected — they're already all in the
bundle regardless of the active language, this only scopes the *backend-served*
`common`/`custom` categories.

### Locales d'un module : le chemin de chargement

Deux sources, fusionnées dans `i18n` par `LocaleService.init()` :

1. **Embarquées** : `locales/locales.<lang>.json` de chaque module lié (dont `react/common/locales/`, clés `common.richtext.editor.*`,
   etc.), collectées au build par `import.meta.glob('/src/modules_shared/**/locales/locales.*.json', { eager: true })` et fusionnées par
   `mergeModuleLocales` (`services/moduleLocales.ts`, ordre des chemins, le dernier gagne sur une clé commune). Elles sont ajoutées **avant** tout
   appel réseau.
2. **Servies par le back** (`GET /locales?lang=`) : `common.<lang>.json`, `custom.<lang>.json` et les `locales/` des modules **Nest** liés.
   Leur contenu s'ajoute aux clés embarquées et gagne sur une clé identique (c'est ainsi qu'une app personnalise un libellé).

**Mode `localesLocation: 'local'`** : plus aucune requête vers `/locales` ; `LocaleService` lit les fichiers statiques
`/locales/<catégorie>.<langue>.json` (dossier `public/locales/` du front) pour chaque langue de `localesLanguages` et chaque catégorie de
`localesCategories` (défaut `common,custom`), fusionnés par langue (la dernière catégorie gagne sur une clé commune). Tous les fichiers listés
doivent exister : un fichier manquant fait échouer le lot (les libellés embarqués restent servis). `getLocales('custom')` ne lit que cette catégorie.
Conséquences : les clés d'un module front (dont `react/common`) sont disponibles dans toutes les apps, que `localesLocation` soit `remote` ou
`local`, et même si la requête échoue ; **il ne faut jamais** les recopier dans les `common.*.json` partagés (hors dépôt). Le `/locales` du back
ne les contient pas, par construction : pour vérifier une clé de module front, regarder le bundle, pas la réponse du back. Tests :
`services/LocaleService.spec.ts`, `services/LocaleService.local.spec.ts` (mode local), `services/moduleLocales.spec.ts`.

---

## `ProwlService` (navigateur) — clé fournie par l'appelant (2026-10-18)

`prowlService.notify(event, description, { apiKey, application? })` : la clé n'est plus lue dans `VITE_PROWL_API_KEY`
(toute variable `VITE_*` est inlinée dans le bundle public, donc lisible par tout visiteur). L'appelant fournit la clé —
typiquement la clé Prowl personnelle de l'utilisateur connecté (`prowlid` de son profil). Les notifications de l'application
elle-même passent par le back (`nest/common` `ProwlService`, clé dans `back/.env`). Aucun consommateur front recensé à cette date.

**`VITE_TECH_TOKEN` — retiré le 2026-10-18** : `ConfigurationService.registerRemoteApiTokens()` (qui enregistrait cette
valeur comme Bearer des modules distants) est **supprimé** ; TradeKong, dernier utilisateur, lit désormais ses modules
distants via le relais de son back (`getReadApiUrl`, ci-dessous). `HttpService.registerApiToken` reste, `@deprecated`
(des `configApis.ts` inutilisés l'appellent encore). Le garde de build (`vx-env-guard`) fait désormais **échouer** le
build si une telle valeur atteint le bundle.

## Modules distants — `isRemoteModule()` et `isAvailable()` (2026-09-23)

`configurationService.isRemoteModule(moduleId)` : vrai quand `getApiUrl(moduleId)` pointe vers une API distante (valeur absolue de `api_url_<moduleId>`), pas vers le backend de l'app. Sert à passer un module en lecture seule quand ses écritures et son admin vivent dans l'app qui l'exécute (ex. `wallet-intelligence` servi par ChainTradingDataAPI).

`configurationService.getReadApiUrl(moduleId)` (2026-10-18) : base des **lectures** du navigateur. Module local ⇒ `getApiUrl(moduleId)` ; module distant ⇒ `<VITE_API_URL>/relay` (`REMOTE_READ_RELAY_PATH`), le relais du back de l'app, qui reprend les chemins locaux du module (`/relay/trading-platforms`, `/relay/market-intelligence/pulse`…) et appelle l'API distante côté serveur avec sa propre clé (`REMOTE_API_KEY`) : aucun identifiant distant dans le bundle. Écritures et admin d'un module distant : non relayés (écrans masqués par `isAvailable()`).

`AdminPage` / `AdminDashboard` : un fichier `Admin*.tsx` ou `Dashboard*.tsx` peut, en plus de son `default`, exporter `isAvailable(): boolean` — évalué au rendu ; `false` masque l'onglet. Ex. `market-intelligence/components/ui/AdminConfig.tsx` : `export const isAvailable = () => !configurationService.isRemoteModule('market-intelligence')`. Sans export, l'onglet est toujours affiché (comportement inchangé pour les autres apps).

## Session applicative — `core/session/` (`appSession`)

`appSession` (instance de `Session`) garde des valeurs par clé (`set`/`get`/`has`/`force`), les
recopie dans `localStorage` (`session:<clé>`) et émet un événement par clé (`addEventListener(clé, cb)`,
écouté par `useSessionKeys`).

- `set(clé, valeur, { force? })` **n'émet pas** quand la valeur se sérialise exactement comme la
  dernière écrite par `set()` pour cette clé (même profil ré-appliqué après un rafraîchissement, même
  configuration…) : chaque abonné re-rendait/relançait pour rien. La comparaison porte sur le JSON
  capturé au `set()` précédent, donc un objet modifié en place puis re-`set()` notifie toujours. Une
  valeur que JSON ne décrit pas (instance de classe, `Map`, `Set`…) notifie toujours ; la première
  écriture d'une clé aussi (y compris quand la valeur venait de `localStorage`).
- Pour forcer la notification : `set(clé, valeur, { force: true })` ou `force(clé)`.
- `adminTokenAuth`/`registerSessionAuth` émettent directement (`dispatchEvent`), non concernés.

## Authentification de session — `sessionAuth`, `AdminTokenGate`, `AppPlugin`

Dépendances : aucune vers `user` (module privé). Les composants admin de `common` passent par un port.

- `auth/sessionAuth.ts` : port `SessionAuthPort` (`mode: 'users' | 'anonymous' | 'local-trust'`, `isAuth`, `isAdmin`, `get`, `clear`, `setLocale`),
  façade `sessionAuth`, `registerSessionAuth(port)` (le dernier gagne, émet la clé `'user'` d'`appSession`) et `isUserManagementEnabled()`.
  Port par défaut : `adminTokenAuth` (mode `anonymous`). `detectLocalTrust()` interroge une fois le back (sans effet si un autre port est enregistré).
- `auth/adminTokenAuth.ts` : sans module `user`, l'admin se déverrouille avec `ADMIN_TOKEN` (env back). `login(token)` valide la clé via
  `GET <api 'common'>/admin-session`, la garde dans `sessionStorage['vx_admin_token']` (mémoire si indisponible) et la pose en
  `Authorization: Bearer`. Un 401 ultérieur passe par `setGlobalUnauthorizedHandler` → `clear()`.
  `detectLocalTrust()` (une seule requête `admin-session` sans clé, ignorée si une clé est stockée) : si le back répond `mode: 'local-trust'` (`LOCAL_TRUST=true`, voir `nest/common/README.md`), le port passe en mode `local-trust` : `isAuth()`/`isAdmin()` vrais, aucune clé, rien à déconnecter.
- `components/ui/admin/AdminTokenGate.tsx` : enveloppe `AdminPage`, `AdminDashboard`, `AdminThemes`. Admin ⇒ contenu ; mode `anonymous` ⇒
  formulaire « Admin key » (affiché après la détection du mode local de confiance, sans clignotement ; en mode `local-trust` le contenu s'affiche directement) ; mode `users` non admin ⇒ comportement historique (`<Unauthorized />`, ou la prop `unauthorized`).
  Clés i18n : `common.admin.tokenGate.{title,label,submit,invalid,logout}`.
- `plugins/` : contrat des plugins d'app, détaillé dans « Plugins du front » plus bas.
- Le module `user` appelle `registerSessionAuth` à l'import de `UserService` : les apps existantes n'ont rien à changer.

## Plugins du front — `plugins/`

Un module lié expose `export const plugin` depuis `<module>/plugin.tsx` ; `front/src/plugins.ts` (gabarit) les collecte
(`collectPlugins(modules, pluginOptions)`) et les enregistre (`registerAppPlugins`, pour les composants de `common` qui les lisent).

```ts
interface AppPlugin {
  id: string;
  order?: number;                              // croissant ; défaut 100 ; égalité = ordre de shared-modules.json
  preload?: { key: string; service: unknown; mode?: 'blocking' | 'background' }[];
  Provider?: ComponentType<{ children }>;
  providerPlacement?: 'outer' | 'inner';       // défaut 'outer'
  HeaderActions?: ComponentType<{ isAuth: boolean; isAdmin: boolean }>;
  routes?: PluginRoute[];                      // layout 'page' par défaut
  adminRoutes?: PluginRoute[];                 // layout 'admin' par défaut
  navMenu?: MenuSection[];                     // barre latérale, tous les visiteurs
  adminMenu?: MenuSection[];                   // barre latérale, pages 'admin', administrateurs
}
type PluginRoute = { path: string; guard?: RouteGuard; layout?: 'page' | 'fullscreen' | 'admin' }
  & ({ element: ReactElement } | { lazy: () => Promise<{ default: ComponentType }> });   // exactement l'un des deux
interface MenuSection { id: string; labelId: string; items: { id; labelId; to; icon; visible?(ctx: MenuContext): boolean }[] }
interface MenuContext { isAdmin: boolean; isAuth: boolean; hasFeature(id: string): boolean }
```

Rétrocompatible : un plugin `{ id, order, preload: [{ key, service }], Provider, HeaderActions, routes, adminRoutes, adminMenu }` (le
plugin `user` d'avant) fonctionne tel quel.

- **Fabrique et options** : `plugin` peut être `(options) => AppPlugin` (`AppPluginFactory`). `collectPlugins` l'appelle avec
  `pluginOptions[<id>]`, l'identifiant étant `factory.pluginId` ou, à défaut, le dossier du module (`./modules_shared/<id>/plugin.tsx`).
  L'app fournit `front/src/config/pluginOptions.ts` (`export const pluginOptions: PluginOptions = {}`, vide par défaut, même principe que
  `back/src/config/pluginOptions.ts`). La fabrique valide avec `requirePluginOptions(id, options, ['clé'])` (`PluginOptionsError` :
  « Plugin "<id>" needs options ... (missing: ... ) »). Ex. prévu : `{ user: { walletMode: 'lazy' } }`.
- **Préchargement** (`core/preload/preloadPlan.ts`) : `buildPreloadPlan(coreServices, plugins)` fusionne les services du cœur
  (`coreServices` exporté par `App.tsx` du gabarit : l'app en retire un, par exemple `crypt`, en supprimant sa ligne) et les `preload` des
  plugins (première déclaration d'une clé gagnante) en `{ blocking, background }`. `PreloaderGate` reçoit `services={blocking}` et
  `background={background}` : un service `background` démarre juste après `ConfigurationService` (ou tout de suite sans configuration),
  n'entre pas dans `ready()` ni dans le libellé de chargement, et une erreur de démarrage est journalisée sans toucher les autres.
  `ready()` exige toujours au moins un service bloquant (la configuration, en pratique).
- **Providers** : `withPluginProviders(tree, plugins, placement)`. `outer` (défaut) : autour du thème, du routeur et du préchargeur ;
  `inner` : à l'intérieur (configuration chargée, routeur et thème disponibles), autour de `PageLayout`.
- **Routes** (`resolveRoutes`) : `resolveRoutes({ appRoutes, plugins, overrides, strict })` renvoie `{ path, element, layout, source }[]` :
  routes de l'app, puis `routes` et `adminRoutes` des plugins dans l'ordre. `lazy` devient un élément `React.lazy` (à rendre dans un
  `Suspense`, ce que fait `Router.tsx`), `guard` enveloppe l'élément. Un chemin déclaré deux fois lève `RouteConfigError` si `strict` (dev),
  sinon `console.error` et la première route gagne. `overrides` (`front/src/config/pluginRoutes.ts`, `PluginRouteOverrides`) : par chemin,
  `false` supprime une route de plugin, un objet remplace ses champs (`element`/`lazy`, `guard`, `layout`) ; les routes de l'app ne
  s'écrasent pas par ce biais. `layoutForPath(routes, pathname)` (`routeLayout.ts`) donne la mise en page de la page courante.
  Mises en page : `page` (en-tête, barre latérale, pied), `admin` (idem, la barre latérale ajoute `adminMenu`), `fullscreen` (la page seule).
- **Gardes** (`guards.tsx`) : `RequireAdmin` (via `AdminTokenGate` : clé admin en mode anonyme), `RequireAuth` (tout principal authentifié),
  `RequireFeature(id)` (fabrique de garde). Point d'extension : `registerFeatureChecker(fn)` (`featureAccess.ts`), que le plugin `user` appellera ;
  sans vérificateur (pas de `user`), `RequireFeature` et `hasFeature` laissent tout passer (`isFeatureGatingActive()` = faux).
- **Menus** (`menus.ts`, `useMenuContext.ts`) : `resolveMenu(sections, ctx, { adminOnly? })` garde les entrées dont `visible(ctx)` n'est pas faux
  et retire les sections vides ; `mergeMenuSections(...listes)` fusionne les sections de même `id` (l'app d'abord). `useMenuContext()` donne
  `ctx` et se met à jour avec la session. `AppSidebar` (gabarit) lit `config/navigation.ts` (`appNavMenu`, `appAdminMenu`) puis les plugins ;
  sans entrée visible, pas de barre latérale.
- **En-tête** : `<PluginHeaderActions placement="end" />` rend les `HeaderActions` de tous les plugins, avec `{ isAuth, isAdmin }`, dans
  n'importe quel en-tête (celui du gabarit, la barre supérieure d'une app).
- Tests : `AppPlugin.spec.ts`, `resolveRoutes.spec.ts`, `menus.spec.ts`, `featureAccess.spec.ts`, `core/preload/preloadPlan.spec.ts`,
  `core/preload/Preloader.spec.ts`. Clés i18n ajoutées : `common.nav.sidebar.{collapse,expand}`.

## Module Configuration Schema

Le système de configuration de module permet d'afficher dans l'interface d'administration les variables de configuration exposées par chaque module backend.

### Services

| Service | Description |
| --- | --- |
| `ModuleConfigService` | Récupère et met à jour les configurations de modules via l'API |

### Types

Les types sont définis dans `types/ModuleConfigSchema.ts` :

```typescript
type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'json' | 'secret';

type ConfigFieldSchema = {
  key: string;           // Clé de configuration
  label: string;         // Label affiché
  description?: string;  // Description / aide
  type: ConfigFieldType; // Type de champ
  defaultValue?: any;    // Valeur par défaut
  options?: ConfigFieldOption[];  // Pour type 'select'/'multiselect'
  dynamicOptionsKey?: string;     // Pour type 'select'/'multiselect' — voir RouteRegistry ci-dessous
  validation?: ConfigFieldValidation;
  group?: string;        // Groupe pour organiser les champs
  hidden?: boolean;      // Masque le champ dans l'UI générique
  visibleWhen?: { field: string; in: string[] };  // Visibilité conditionnelle — voir ci-dessous
};

type ModuleConfigSchema = {
  moduleId: string;      // ID unique du module
  moduleName: string;    // Nom affiché
  description?: string;  // Description du module
  icon?: string;         // Icône
  fields: ConfigFieldSchema[];
};

type ModuleConfigWithValues = ModuleConfigSchema & {
  currentValues: Record<string, any>;
};
```

### Composant ConfigurationSettings

Le composant `ConfigurationSettings` affiche :
- Un bloc "Global Configuration" avec toutes les variables de configuration globales
- Un bloc par module enregistré côté backend avec ses variables de configuration

#### Props

```typescript
type ConfigurationSettingsProps = {
  showGlobalConfig?: boolean;   // Afficher la config globale (default: true)
  showModuleConfigs?: boolean;  // Afficher les configs de modules (default: true)
  title?: string;               // Titre de la card
  subtitle?: string;            // Sous-titre
};
```

#### Utilisation

```tsx
import { ConfigurationSettings } from '@/modules_shared/common/components/ui/ConfigurationSettings';

// Afficher tout (global + modules)
<ConfigurationSettings />

// Afficher uniquement les modules
<ConfigurationSettings showGlobalConfig={false} />

// Afficher uniquement la config globale
<ConfigurationSettings showModuleConfigs={false} />

// Personnaliser le titre
<ConfigurationSettings
  title="Application Settings"
  subtitle="Manage all configurations"
/>
```

### API utilisée

| Méthode | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/admin/module-configs` | Récupère tous les modules avec valeurs |
| GET | `/api/v1/admin/module-configs/:moduleId/secret/:key` | Déchiffre et renvoie la valeur d'un champ `secret` (`getSecretValue`) |
| PUT | `/api/v1/admin/module-configs/:moduleId` | Met à jour les valeurs d'un module |

### Types de champs supportés

| Type | Description | Rendu |
| --- | --- | --- |
| `string` | Texte simple | TextField |
| `number` | Nombre avec validation min/max | TextField type="number" |
| `boolean` | Booléen | Checkbox |
| `select` | Choix unique | Select dropdown |
| `multiselect` | Choix multiples | (à implémenter) |
| `json` | Objet JSON | TextField multiline |
| `secret` | Mot de passe / clé API | TextField type="password" |

### Révéler et copier un champ `secret` (`copyableKeys`)

`ModuleConfigForm` accepte une prop `copyableKeys?: string[]` listant des clés de champs pour lesquelles afficher un bouton copier-coller.
- Champs non-`secret` : le bouton copie directement la valeur affichée.
- Champs `secret` : un bouton "Révéler" (👁) apparaît en plus, qui appelle `moduleConfigService.getSecretValue(moduleId, key)` (`GET /api/v1/admin/module-configs/:moduleId/secret/:key`, admin only) pour déchiffrer la valeur à la demande — jamais renvoyée par les endpoints `getModuleConfig`/`getAllWithValues`. Une fois révélée, la valeur s'affiche en clair (lecture seule) et devient copiable ; "Masquer" (🙈) l'efface de l'état du composant. La valeur révélée est aussi effacée automatiquement après un save ou un refetch.

```tsx
<ModuleConfigForm moduleId="tokenCreator" groups={['signals']} copyableKeys={['token_solbixApiKey', 'token_pumpFunAuthToken']} />
```

### Groupes de champs

Les champs peuvent être organisés en groupes via la propriété `group`. Les groupes disponibles avec leurs labels :

- `general` → "General"
- `polling` → "Polling"
- `streaming` → "Streaming"
- `reliability` → "Reliability"
- `sources` → "Sources"
- `filtering` → "Filtering"
- `performance` → "Performance"

Pour ajouter un nouveau groupe, modifier `groupLabels` dans `ConfigurationSettings.tsx`.

Le module `common` en expose quatre de plus, tous rendus par `AdminCommunicationChannels.tsx` (`groups={['email', 'brand', 'social', 'storage']}` — un groupe non listé dans ce prop reste invisible dans TOUTE page admin, même si son schéma est bien enregistré côté back : c'est l'oubli qui a initialement laissé `storage` invisible) :

- `email` → prestataire d'envoi, identifiants, débit, quota et coût, secret des webhooks
- `brand` → identité du site : URL, nom, logo, couleur d'accent, mention légale, adresse postale
- `social` → URL des réseaux sociaux (une clé vide n'affiche rien)
- `storage` → provider de stockage des images inline (`local`/`r2`) et identifiants du bucket Cloudflare R2 — voir README `common` back, section « Stockage R2 »

`common_brand_siteUrl` est la seule URL absolue connue du backend : tout ce qu'il génère pour l'extérieur (e-mails, permaliens, liens de suivi) en dépend. `VITE_APP_URL` existe côté front mais n'est jamais lu et ne joue aucun rôle ici.

### Visibilité conditionnelle (`visibleWhen`)

Un champ peut déclarer `visibleWhen: { field: '<clé d'un autre champ>', in: ['valeur', ...] }`. `ModuleConfigForm` ne le rend que si la valeur courante du champ pilote figure dans `in` (comparaison en chaîne), en lisant d'abord l'état vivant du formulaire — le formulaire se réorganise donc immédiatement quand on change le champ pilote, sans sauvegarde. Un groupe dont tous les champs sont masqués n'affiche plus sa section. Les valeurs des champs masqués restent stockées, elles ne sont simplement ni affichées ni éditables.

Exemple (`emailConfigSchema` du module `common`) : `common_email_provider` (`none` / `brevo` / `mailjet` / `smtp`) pilote l'affichage — tant que `none` est sélectionné, aucun champ d'identifiants n'est visible ; sinon seuls ceux du provider choisi le sont.

```typescript
{
  key: 'common_email_mailjetSecretKey',
  type: 'secret',
  group: 'email',
  visibleWhen: { field: 'common_email_provider', in: ['mailjet'] },
}
```

### Options dynamiques (`dynamicOptionsKey`) — `RouteRegistry`

Un champ `select`/`multiselect` peut déclarer `dynamicOptionsKey: 'appRoutes'` (voir `types/ModuleConfigSchema.ts`) au lieu (ou en plus) d'un `options` statique. `ModuleConfigForm` résout alors les choix supplémentaires via `RouteRegistry` (`services/RouteRegistry.ts`), un registre en mémoire, vide par défaut, que chaque app remplit à son démarrage :

```typescript
import { routeRegistry } from '@/modules_shared/common/services/RouteRegistry';

routeRegistry.register('appRoutes', [
  { value: '/pricing', label: 'Pricing' },
  { value: '/pricing#plans', label: 'Pricing — Plans section' },
]);
```

Cela permet à un module partagé (ex: `cms`) d'exposer un champ de config "route de destination" sans connaître le `Router.tsx` de l'app consommatrice — le champ ne perd que sa liste d'options (`options` statique reste utilisable en repli) si l'app ne fait pas l'enregistrement.

---

## Système de thèmes visuels

Le module `common/theme/` fournit un système de thèmes à trois couches : **visuel** (couleurs, fonts, images), **shell** (structure de l'app) et **interaction** (navigation et actions).

### Activation

Le système est activé par défaut. Pour le désactiver (masque le sélecteur utilisateur, force le thème par défaut) :
- Backend : positionner `common_themes_enabled = false` dans `ConfigurationEntity`
- L'attribut `data-color-scheme` (`dark` | `light`) gère le mode sombre — distinct de `data-theme` qui gère le thème visuel.

### Architecture

Les thèmes eux-mêmes sont **app-spécifiques** et vivent dans `front/src/themes/` (ou équivalent dans chaque app). Le module `common/theme/` ne fournit que l'infrastructure.

```
common/theme/                      # Infrastructure partagée (reactcommon)
  types.ts                        # ThemeDefinition, ShellType, InteractionMode, ThemeImageKey
  themes.ts                       # ThemeRegistry — singleton vide, les apps y enregistrent leurs thèmes
  themeImages.ts                  # Registry d'images : clés → URL avec fallback
  VisualThemeService.ts           # Service singleton : applique data-theme, persiste en localStorage
  VisualThemeContext.tsx          # React context + VisualThemeProvider
  ThemeShell.tsx                  # Dispatcher shell (standard → StandardShell, terminal → TerminalShell)
  hooks/
    useVisualTheme.ts             # { activeTheme, availableThemes, setTheme, isEnabled }
    useThemeImage.ts              # useThemeImage(key) → URL résolue (thème → app → défaut)
  commands/
    CommandRegistry.ts            # Parse et dispatch les commandes texte (/route, action)
    CommandHistory.ts             # Historique ↑↓ persisté en localStorage
  shells/
    StandardShell.tsx             # Pass-through (layout géré par l'app)
    TerminalShell.tsx             # Shell terminal plein écran avec prompt CLI
  components/
    ThemeAction.tsx               # Action sémantique (bouton en standard, hint commande en CLI)
    ThemeNav.tsx                  # Navigation sémantique (sidebar en standard, barre hints en CLI)
    UserAdminThemes.tsx           # Sélecteur de thème utilisateur (retourne null si désactivé)

front/src/themes/                  # Thèmes app-spécifiques
  index.ts                        # Point d'entrée : importe et enregistre tous les thèmes
  default/                        # Thème par défaut — pas de CSS, utilise les :root vars de l'app
  retro-visual/                   # Terminal CRT : vert phosphore, scanlines, monospace, coins carrés
  retro-cli/                      # Retro-visual + shell terminal + navigation CLI
```

### Créer un thème

**1. Créer le dossier** `front/src/themes/mon-theme/` (dans l'app, pas dans reactcommon)

**2. Écrire le CSS** `theme.css` — surcharger uniquement les vars nécessaires :
```css
@import url('…');  /* polices si besoin */

[data-theme='mon-theme'] {
  --color-bg: #…;
  --color-primary: #…;
  --font-primary: '…', sans-serif;
  /* etc. */
}

/* Mode sombre spécifique au thème (si applicable) */
[data-theme='mon-theme'][data-color-scheme='dark'] {
  --color-bg: #…;
}

/* Styles de composants / pseudo-éléments / animations */
[data-theme='mon-theme'] body::after { … }
```

**3. Écrire le descriptor** `index.ts` :
```typescript
import type { ThemeDefinition } from '@/modules_shared/common/theme/types'
import './theme.css'   // ← import side-effect pour que Vite bundle le CSS

export const monTheme: ThemeDefinition = {
  id: 'mon-theme',
  name: 'common.theme.monTheme.name',  // clé i18n
  description: 'common.theme.monTheme.description',
  shell: 'standard',       // 'standard' | 'terminal' | 'amstrad'
  interaction: 'standard', // 'standard' | 'cli' | 'basic'
  fonts: [{ family: 'Ma Police', url: 'https://…' }],
  images: { logoMain: '/themes/mon-theme/logo.svg' },  // optionnel
  commands: {              // seulement pour cli/basic
    '/mapage': { route: '/ma-page', description: 'Aller à ma page' },
  },
  builtIn: true,
}
```

**4. Enregistrer** dans `front/src/themes/index.ts` :
```typescript
import { monTheme } from './mon-theme'
themeRegistry.register(monTheme)
```

**5. Ajouter les clés i18n** dans `<module>/locales/locales.{en,fr}.json` du module (voir « Locales d'un module » ci-dessous) — jamais dans les `common.*.json` partagés.

### Intégration dans l'app

```tsx
// App.tsx (ou équivalent)
import { VisualThemeProvider } from '@/modules_shared/common/theme/VisualThemeContext'
import { ThemeShell } from '@/modules_shared/common/theme/ThemeShell'

function App() {
  return (
    <ThemeModeProvider>
      <VisualThemeProvider>
        <BrowserRouter>
          <ThemeShell appName="MonApp">
            <RouterOutlet />
          </ThemeShell>
        </BrowserRouter>
      </VisualThemeProvider>
    </ThemeModeProvider>
  )
}
```

VisualThemeProvider doit être à l'intérieur de `PreloaderGate` (après le chargement de `configurationService`).

### Palette MUI pilotée par CSS (`ThemeModeProvider`)

`ThemeModeProvider` construit le thème MUI à partir de variables CSS lues (valeurs résolues) sur `document.documentElement`, recalculées à chaque changement de mode :

| Palette MUI | Variable CSS | Si absente |
|---|---|---|
| `primary.main` | `--accent-strong` | `#1fcb7d` |
| `secondary.main` | `--color-primary-strong` | `#24d996` / `#0f794d` |
| `background.default` / `.paper` | `--color-bg` / `--color-surface` | `#111418`/`#f2f3f5` · `#181c22`/`#ffffff` |
| `error.main` / `success.main` / `warning.main` | `--color-danger` / `--color-success` / `--color-warning` | défaut MUI |
| `text.primary` / `text.secondary` | `--color-text` / `--color-text-muted` | défaut MUI |
| `divider` | `--color-border` | défaut MUI |

Ces variables doivent être déclarées dans une feuille chargée au démarrage (pas seulement dans un CSS importé paresseusement par une page) et se résoudre en couleur simple (hex/rgb/rgba) — MUI ne sait pas analyser `color-mix()`.

### Anti-FOUC

Chaque app doit ajouter dans son `index.html` (avant `<script type="module">`) :
```html
<script>
  (function () {
    var t = localStorage.getItem('vx_visual_theme') || 'default';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-color-scheme', 'dark');
  })();
</script>
```

### Images thémées

```tsx
import { useThemeImage } from '@/modules_shared/common/theme/hooks/useThemeImage'

function Header() {
  const logo = useThemeImage('logoMain')
  return <img src={logo} alt="Logo" />
}
```

Enregistrer les images par défaut de l'app au démarrage :
```typescript
import { themeRegistry } from '@/modules_shared/common/theme/themes'
themeRegistry.setDefaultImages({ logoMain: '/images/mon-logo.svg' })
```

### Actions et navigation sémantiques

```tsx
import { ThemeAction } from '@/modules_shared/common/theme/components/ThemeAction'
import { ThemeNav } from '@/modules_shared/common/theme/components/ThemeNav'

// Bouton en mode standard, hint "/launch" en mode CLI
<ThemeAction
  label="Lancer le bot"
  onAction={handleLaunch}
  command="/launch"
  variant="primary"
/>

// Sidebar en standard, barre de hints en CLI
<ThemeNav
  items={navItems}
  renderStandard={(items) => <MySidebar items={items} />}
/>
```

### CSS — règle de migration

Toutes les surcharges dark/light utilisent désormais `[data-color-scheme='dark']` (et non plus `[data-theme='dark']`). L'attribut `data-theme` est réservé au thème visuel sélectionné.

### Config flag

| Clé | Type | Défaut | Description |
|-----|------|--------|-------------|
| `common_themes_enabled` | boolean | `true` | Active/désactive le sélecteur de thème utilisateur |

---

## Composants

| Nom | Description |
| --- | --- |
| `RichTextEditor` (`components/ui/richtext/RichTextEditor.tsx`) | Éditeur WYSIWYG basé sur TipTap (`@tiptap/react` + `starter-kit` + `extension-image` + `extension-text-align` + `extension-text-style` + `extension-color`, toutes en `^3.27.3` dans `package.base.json` de l'app-template), déplacé depuis le module `cms` pour être réutilisable par n'importe quel module `reactcommon` (ex. `user/AdminCommunications.tsx` pour l'en-tête/pied de page e-mail d'un motif, `user/AdminTiers.tsx` pour la description d'un palier). Props : `value: string`, `onChange: (html: string) => void`, `onUploadImage?: (file: File) => Promise<string>` (upload réel d'une image insérée — appelant fourni, plus de couplage `articleId`/`cmsService` en dur ; en son absence, repli en base64 inline), `minHeight?: number` (défaut `260`), `imagesInline?: boolean` (défaut `false` — voir plus bas). Toolbar (dans l'ordre) : gras/italique/souligné/barré/listes/citation, **alignement gauche/centre/droite**, **couleur de texte** (`<input type="color">` caché derrière l'icône + bouton de réinitialisation), lien, insertion d'image par bouton ou glisser-déposer sur la zone d'édition (`preventDefault` pour éviter la navigation plein-page du navigateur), vidéo, YouTube, puis **le sélecteur de style de bloc** (Titre 1 à 4, Corps de texte) tout à la fin — chaque option de ce menu est rendue avec sa propre taille/graisse (`blockTypeStyle`) au lieu d'un texte uniforme, pour prévisualiser réellement le style choisi.

**Images — lien, alignement, `imagesInline`.** L'image (`LinkableImage`, extension locale de `@tiptap/extension-image`) porte un attribut `href` : le mark `Link` ne peut pas s'appliquer à un node atome, donc l'image sélectionnée reçoit un lien via le même bouton « Lien » du toolbar, et `renderHTML` enveloppe alors le `<img>` dans un `<a href>`, ce qui la rend cliquable dans l'e-mail reçu (jamais dans l'éditeur lui-même sur un clic simple — voir plus bas). Par défaut (`imagesInline: false`, comportement des articles CMS/description de palier), l'image reste un bloc à elle seule sur sa propre ligne ; les boutons d'alignement du toolbar centrent alors cette ligne (via `TextAlign`, sur le paragraphe englobant) exactement comme pour du texte — `updateAttributes`/`setTextAlign` remontent au paragraphe ancêtre même quand la sélection courante est une `NodeSelection` sur l'image, pas une sélection de texte. Avec `imagesInline: true` (activé sur les 4 zones en-tête/pied de page de motif d'`AdminCommunications.tsx`), l'image devient un node **inline** au même titre qu'un mot de texte : plusieurs images peuvent alors cohabiter sur une même ligne (ex. une rangée d'icônes réseaux sociaux), un espace tapé au clavier entre deux les sépare, et centrer la ligne centre le groupe entier — c'est ce que produit désormais `EmailLayoutService.renderSocialRow()` (back, module `common`) : un unique `<p style="text-align:center">` d'`<a href><img></a>` inline séparés par `&nbsp;`, plutôt qu'un `<table>` de cellules (qui n'a pas d'équivalent dans le schéma TipTap ici — aucune extension table chargée — et se faisait donc silencieusement disperser/écraser au premier chargement dans la zone d'édition).

**Image responsive à l'export.** `LinkableImage.renderHTML()` fusionne désormais `style: 'max-width:100%;height:auto;'` en tout premier (priorité la plus basse — `mergeAttributes` fusionne `style` propriété par propriété, jamais en écrasant toute la chaîne, donc un futur style explicite par image gagnerait) avant `this.options.HTMLAttributes`/`HTMLAttributes` : `insertImageFile()`/`setImage({ src, alt })` ne fixe autrement aucune taille, donc une image insérée s'exportait (`getHTML()`) à sa taille naturelle en pixels, sans aucune contrainte — la règle CSS locale `'& img': { maxWidth: '100%', height: 'auto' }` (`editorSx`) ne s'applique qu'au canevas de CE composant, jamais au HTML exporté, donnant l'illusion trompeuse que l'image était déjà responsive. Concrètement, une bannière d'en-tête de motif de communication (`AdminCommunications.tsx`) forçait tout le tableau e-mail à s'élargir au-delà de 600px sur un viewport étroit (aperçu mobile de l'admin, client mail mobile réel). Le HTML déjà enregistré avant ce correctif reste sans cette propriété tant qu'il n'est pas réédité dans cet éditeur — un filet de sécurité côté rendu existe côté back (`EmailLayoutService.ensureResponsiveImages()`, voir README du module `common` back) et corrige rétroactivement.

**Clic sur un lien dans l'éditeur.** `StarterKit` embarque `@tiptap/extension-link` avec `openOnClick: true` par défaut — un plugin ProseMirror qui intercepte le clic sur n'importe quel `<a>` de l'éditeur (y compris celui de `LinkableImage`, sans rapport avec le mark `Link`) et appelle `window.open()` directement, tout en empêchant la sélection par défaut du node cliqué. Désactivé (`StarterKit.configure({ link: { openOnClick: false } })`) : `handleEditorClick` gère alors lui-même le clic sur un lien (texte ou image) — bloqué sur un clic simple (juste édition/sélection normale), laissé au comportement natif du navigateur (nouvel onglet) sur Ctrl/Cmd+clic.

Un échec d'`onUploadImage` affiche une alerte sous la toolbar au lieu d'insérer silencieusement rien. Clés i18n : `common.richtext.editor.*` (`locales/locales.{en,fr}.json` de ce module — première fois que le module front `common` a ses propres fichiers de locale). |
| `TranslateIconButton` (`components/ui/TranslateIconButton.tsx`) + `hooks/useLlmTranslateAvailable.ts` | Bouton icône baguette magique (`AutoFixHighIcon`) + tooltip « Traduire », à placer en `startAdornment` (gauche) d'un `TextField` cible dans n'importe quel module (partagé ou non) qui édite un champ multi-locales, à côté du champ FR source. Props : `{sourceText, targetLocale, sourceLocale?, onTranslated, disabled?}`. Invisible si `useLlmTranslateAvailable()` (probe `GET …/llm-client-accesses/default-model`, mise en cache par session) est `false` ou si `sourceText` est vide. Vit ici plutôt que dans `llm-client` : parle au backend `llm-client` **uniquement par URL** (`POST …/llm-client/translate`), sans importer aucun type de ce module — `common` est lié par toutes les apps, `llm-client` ne l'est pas forcément (un import direct depuis `llm-client` cassait le build de toute app qui ne le lie pas). Clés i18n `llm_translate`/`llm_translateError` servies par `nestcommon/llm-client/locales`. |
| `KpiGrid` / `KpiTile` (`components/ui/charts/KpiGrid.tsx`, exports nommés + défaut `KpiGrid`) + `utils/deltaFormat.ts` | Grille responsive de tuiles KPI, purement présentationnelle (aucune donnée récupérée). `KpiGrid` : `tiles: KpiTileData[]`. `KpiTileData` / props de `KpiTile` : `label: React.ReactNode`, `value: string`, `deltaPct?: number \| null` (vert si > 0, rouge si < 0, grisé si nul ; `null` affiche « — » ; `undefined` masque la variation), `deltaLabel?: string`. `utils/deltaFormat.ts` exporte `formatDelta(value)` (`+1.2%`) et `deltaColor(value)` (chemin de palette MUI). Déplacé depuis le module privé `commerce`. |
| `TrendChart` (`components/ui/charts/TrendChart.tsx`, export nommé + défaut) | Courbe d'évolution dans le temps (`chart.js` + `react-chartjs-2`, déjà dans `package.base.json`). Props : `labels: string[]`, `series: TrendChartSeries[]` (`{ label: string; data: number[]; color?: string }`, palette par défaut de 4 couleurs), `height?: number` (défaut `280`). Légende affichée seulement s'il y a plus d'une série ; axe Y à partir de 0. Déplacé depuis le module privé `commerce`. |
| `CookieConsentBanner` (`components/ui/CookieConsentBanner.tsx`) + `CookieConsentSettingsModal` (`components/ui/CookieConsentSettingsModal.tsx`) + `utils/cookieConsent.ts` (2026-09-14) | Bandeau de consentement cookies, monté une fois depuis `PageLayout.tsx` app-level. Non bloquant (bandeau bas de page, pas d'overlay) — n'apparaît que si `getCookieConsent()` renvoie `null` (cookie `vx_cookie_consent` absent/expiré). Trois actions à poids visuel égal (couleur accent jaune du thème, `var(--accent-strong)`, plus de vert) : « Tout accepter », « Continuer sans accepter » (refus réellement enregistré, pas un simple report), « Personnaliser » → ouvre `CookieConsentSettingsModal` (cookies nécessaires verrouillés actifs, mesure d'audience décochée par défaut, bouton « Enregistrer »). Un bouton fermer (icône X, `common.cookieConsent.close`) sur le bandeau et sur la modale (également accessible via Escape/clic backdrop sur la modale) ferme sans enregistrer aucun choix — le bandeau réapparaît au prochain chargement de page puisque `getCookieConsent()` reste `null`. `setCookieConsent()` écrit le cookie client (`Max-Age` 6 mois — fenêtre de validité CNIL) et journalise l'action côté backend en fire-and-forget (`POST /api/v1/cookie-consent`, voir README `common` back). `hasConsent('audienceMeasurement')` est le point de contrôle prêt à l'emploi pour un futur script d'analytics (aucun câblé à ce jour) — voir README backend pour la contrainte des 13 mois qui s'appliquera alors aux cookies de CE script. |
| `confirm()` + `ConfirmHost` (`components/ui/confirm/`) | Dialogue de confirmation par promesse : `if (await confirm({ titleId, messageId?, params?, confirmLabelId?, cancelLabelId?, danger? })) …`. Monter `<ConfirmHost />` une seule fois dans la coquille de l'app. Échap, clic hors du dialogue et « Annuler » répondent `false`. File d'attente séquentielle (`createConfirmQueue`, testée) : deux appels simultanés s'affichent l'un après l'autre. Focus piégé dans le dialogue puis rendu à l'élément d'origine (MUI) ; focus initial sur « Confirmer », ou sur « Annuler » avec `danger` (bouton rouge). Clés `common.ui.confirm.*`. |
| `InfoTip`, `LabelWithTip`, `HelpBody` + type `Help` (`components/ui/help/`) | Info-bulle d'aide « ? » (16 px, ne prend pas de place au contrôle décrit). S'ouvre au survol, au focus clavier et au toucher/clic, se ferme avec Échap. `Help` = `{ titleId?, title?, bodyId?, body?: ReactNode, tipId?, tip? }` : chaque texte est une clé i18n (prioritaire) ou une chaîne déjà traduite (données venant d'un serveur). `<InfoTip {...help} side? />`, `<LabelWithTip help={help}>Libellé</LabelWithTip>`, `<HelpBody {...help} />` (contenu seul, réutilisable dans un `Tooltip`). Clés `common.ui.infoTip.*`, `common.ui.help.tip`. |
| `Kbd`, `TipIconButton` (`components/ui/kbd/`, `components/ui/iconbutton/`) | `<Kbd>Ctrl+K</Kbd>` : raccourci clavier. `TipIconButton` = `IconButton` MUI + nom accessible + info-bulle : `labelId` (clé i18n, nom et texte de l'infobulle), `kbd?`, `hintId?` (explication longue, l'infobulle passe en mode riche), `tone?: 'ghost' \| 'default' \| 'danger'`, `active?` (`aria-pressed`), `tipSide?`, plus toutes les props d'`IconButton`. Fonctionne désactivé (l'infobulle reste). Aucun `IconButton` n'était exporté par `common` : pas de conflit de nom (celui de MUI reste utilisable tel quel). |
| `ProgressBar`, `IndeterminateBar` (`components/ui/progress/`) | `<ProgressBar done total rate? etaSeconds? />` (octets) : « 12 Mo / 340 Mo · 4 % », débit, temps restant (estimé depuis `rate` si `etaSeconds` absent) ; total inconnu = « Préparation… ». `<IndeterminateBar message? detail? sinceEpochSeconds? />` : sans pourcentage, avec temps écoulé rafraîchi chaque seconde. Formatage localisé par `Intl` (langue de `i18n.getLang()`), puissances de 1024 : `formatBytes`, `formatRate`, `formatDuration`, `formatClock`, `computePercent`, `estimateRemaining` (`progressFormat.ts`, testés). Clés `common.ui.progress.*`. |
| `FileDropzone`, `useWindowDrop` (`components/ui/filedrop/`) | `<FileDropzone accept? multiple? maxSizeBytes? onFiles onRejected? disabled? />` : zone de dépôt et sélecteur (clic, Entrée, Espace). `useWindowDrop({ accept?, multiple?, maxSizeBytes?, enabled?, onFiles, onRejected? })` : dépôt sur toute la fenêtre, renvoie `{ dragging }` pour afficher une surcouche ; ne réagit qu'aux glissements de fichiers. `accept` suit l'attribut HTML (`image/*,.pdf,audio/wav`). Le filtrage (`filterFiles`, testé) sépare acceptés et rejetés avec la raison (`type`, `size`, `count` — hors `multiple`, seul le premier fichier acceptable est gardé). Aucun envoi réseau : brancher `onFiles` sur `httpService.upload`. Clés `common.ui.dropzone.*`. |
| `SchemaParamsForm`, `SchemaParamsPopover` (`components/ui/schemaform/`) | Formulaire de réglages généré depuis un schéma générique `ParamsSchema` (liste de `ParamField`, voir `schemaTypes.ts`). Champs : `int`/`float` (`default`, `min?`, `max?`, `step?` ; curseur si `min` et `max` sont donnés, sinon champ numérique), `bool`, `select` (`options`), `text` (`placeholder?`). Communs : `key`, `labelId`/`label`, `help?` (`InfoTip`), `advanced?` (section repliable), `showWhen?: { key, equals }`. Contrôlé : `values` (clé absente = défaut), `onChange(patch)` reçoit la valeur déjà normalisée (bornée, arrondie ; `coerceValue`). `titleId?` affiche un titre et le bouton « Valeurs par défaut » ; `children` s'insère après les contrôles de base. `SchemaParamsPopover` ajoute le bouton déclencheur (`triggerLabelId`, `icon?`, `width?`) avec un point quand une valeur diffère du défaut. Logique pure testée dans `schemaControls.ts`. Clés `common.ui.schemaForm.*`. |
| `Waveform`, `WaveformPending`, `AudioPlayer`, `useSharedAudioPlayer`, `useMicRecorder`, `Lightbox`, `VideoPoster` (`components/ui/media/`, import par `index.ts`) | Composants médias génériques (aucun modèle ni API métier : données et rappels en props). **`Waveform`** `{ peaks, progress?, onSeek?, floor?, active?, keyboardStep?, height? }` : barres 0..1 ; avec `onSeek`, clic/glisser et clavier (flèches, PageUp/Down, Début/Fin) ; sans `onSeek`, lecture seule. **`WaveformPending`** `{ fraction?, active?, bars?, height? }` : barres animées (désactivées par `prefers-reduced-motion`). **`AudioPlayer`** `{ id, url, peaks?, duration?, autoPlay?, compact?, rates?, footer?, onAutoPlayBlocked? }` : lecture/pause, onde, horloge, menu de vitesse. **`useSharedAudioPlayer(id, url)`** : un seul `<audio>` par onglet (`getSharedAudioPlayer()`), donc lancer un son arrête l'autre ; renvoie `{ current, playing, time, duration, rate, blocked, toggle, play(startAt?), pause, seek(fraction), setRate, stop }` ; `play` ne met jamais en pause (lecture automatique), `blocked` passe à vrai si le navigateur refuse. Logique dans `createSharedPlayerStore(element)` (élément injectable, testé). **`useMicRecorder({ onDone, fileName?, toWav? })`** : renvoie `{ state, seconds, level (0..1), start, stop, cancel, reset }` ; `state` ∈ `idle, requesting, recording, processing, denied, no-device, error, unsupported` (refus de permission = état, pas exception) ; `onDone({ blob, wav, seconds })`, `wav` = WAV mono 16 bits (`null` si le décodage échoue) ; pistes et `AudioContext` libérés à l'arrêt, à l'annulation et au démontage. Utilitaires purs testés : `computePeaks(samples, bins)`, `downmixToMono(channels)`, `encodeWavMono(samples, rate)` (`ArrayBuffer`), `rmsLevel`, `classifyMicError` ; navigateur : `toMonoWavFile(blob, name)`, `readAudioPeaks(blob, bins)`. **`Lightbox`** `{ items: LightboxItem[], index, onIndexChange, onClose, actions?, sidePanel?, sidePanelOpen?, thumbnails? }` (`LightboxItem` = `{ id, type: 'image' \| 'video', url, thumbUrl?, alt?, caption? }`) : plein écran, ←/→ (sans bouclage, ignorés dans un champ de saisie), Échap, compteur, clic sur une image pour zoomer, vidéo en lecture automatique ; `actions` (nœud ou `(item, index) => nœud`) ajoute des boutons à la barre, `sidePanel(item, index)` un panneau de détails avec bouton d'affichage ; l'appelant gère suppression et liste (index contrôlé, `clampIndex` après retrait). **`VideoPoster`** `{ src, poster, width?, height?, durationSeconds?, caption?, alt?, onOpen, overlay? }` : vignette au ratio réel, aperçu muet en boucle au survol ou au focus, repli sur l'image si la vidéo échoue, pastille de durée. Clés `common.ui.media.*` (dont `mic.*` pour les messages d'état du micro, affichés par l'appelant). Tests : `*.spec.ts` du dossier (pics, WAV octet par octet, downmix, file du lecteur, navigation). |

| `DonateButton` (`components/ui/DonateButton.tsx`) + `DonationDialog`/`AmountPicker`/`CryptoPayPanel`/`StripePanel`/`PaypalPanel` (`components/ui/donation/`) + `services/donationApi.ts` + `hooks/useDonationConfig.ts` + `AdminDonations` (`components/ui/AdminDonations.tsx`, découvert automatiquement par `AdminPage`) | Widget de don autonome, sans `plugin.tsx` ni emplacement imposé : `<DonateButton />` s'intègre où l'app le souhaite (footer, en-tête, page dédiée) et ouvre `DonationDialog`. Non-custodial — aucune confirmation/suivi de paiement, voir README `common` back, section « Dons ». `DonationDialog` affiche `AmountPicker` (presets + montant libre, `parseAmountInput` testé) puis un onglet par méthode activée et configurée (`useDonationConfig` → `GET …/donations/config`) : `CryptoPayPanel` (Bitcoin/EVM/Solana — adresse + QR `qrcode.react` + bouton copier, montant via `GET …/donations/quote`), `StripePanel` (`POST …/donations/stripe/checkout-session`, ouvre l'URL Stripe Checkout dans un nouvel onglet), `PaypalPanel` (lien `paypal.me/<user>/<montant>USD`, aucun appel backend). `AdminDonations` lit/écrit les clés `donations_*` via `moduleConfigService.getModuleConfig('common')`/`updateModuleConfig('common', …)` (champs `hidden: true` du schéma générique, donc invisibles dans le formulaire générique). Clés i18n `common.donations.*`. |

## Internationalisation — `I18nLabel` / `i18n.get()`

**Aucun libellé de repli n'est possible : c'est délibéré.** Une traduction manquante doit
apparaître à l'écran sous forme de clé brute (`user.admin.tiers.title`) pour être détectée
et corrigée, jamais être masquée par un texte codé en dur (règle `CLAUDE.md` §5).

```tsx
<I18nLabel id="user.admin.tiers.title" />
<I18nLabel id="commerce.product.period.every" params={[count]} />   // substitue {0}, {1}, …
i18n.get('user.account.subscription.renewalText', [date]);
```

### API

| Signature | Notes |
|---|---|
| `<I18nLabel id params? nolf? />` | `params` alimente les jokers `{0}`, `{1}`, … de la traduction |
| `i18n.get(key, params?)` | retourne `key` telle quelle si la clé est absente |
| `i18n.getForLang(key, lang)` | lecture dans une langue précise, sans substitution |

### Nom du site dans les libellés

Les clés `common.banner.devNotice.*`, `common.disclaimer.footer` et `common.auth.signup` contiennent
le joker `{0}` = nom du site. Côté front, le nom du site est la clé de locale `custom.app.name`
(`back/src/locales/custom.<lang>.json`, rempli avec `{{SITE_NAME}}` à la création du projet) :

```tsx
<I18nLabel id="common.disclaimer.footer" params={[i18n.get('custom.app.name')]} />
```

Côté back (e-mails…), le nom provient de `BrandService.getSiteName()` (clé de config `common_brand_siteName`),
transmis en paramètre de `LocaleService.translate(key, lang, [siteName])`.

### Rupture d'API (2026-08-30)

Le prop `defaultLabel` de `<I18nLabel>` et le 2ᵉ argument `defaultLabel` de `i18n.get()`
**ont été supprimés**. Ils masquaient silencieusement les clés absentes.

Migration d'un projet consommateur, **dans cet ordre** :

1. `node .libs/apptemplate/scripts/check-i18n.mjs` depuis `front/` — recense les clés
   référencées mais absentes. Les combler AVANT de retirer les replis, sinon l'interface
   affichera des clés brutes.
2. Retirer les `defaultLabel={…}` des `<I18nLabel>` et les valeurs de repli des appels
   `i18n.get(key, 'texte')` / `i18n.get(key) ?? 'texte'`.
3. Réécrire `i18n.get(key, undefined, params)` en `i18n.get(key, params)`.
4. Cas particulier : si un `defaultLabel` variait selon une condition alors que `id` était
   fixe, la distinction est portée par le libellé de repli et serait perdue — rendre `id`
   ternaire avec deux clés distinctes, définies dans les locales du module concerné.

Les locales d'un module vivent dans `<module>/locales/locales.{en,fr}.json` et sont livrées
avec lui : un module doit être autosuffisant, sans dépendre des clés d'un module voisin.
