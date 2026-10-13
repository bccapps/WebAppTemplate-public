# Common Module

## Rôle
Fournit l'infrastructure transversale du backend : configuration applicative, internationalisation, chiffrement des transports et notifications.

## Capabilities principales
| Domaine | Description |
| --- | --- |
| Configuration | `ConfigurationController` + `ConfigurationService` exposent/chargent les paramètres depuis `ConfigurationEntity` (TypeORM).
| Module Config | `ModuleConfigController` + `ModuleConfigService` + `ModuleConfigRegistry` permettent aux modules d'exposer leurs propres variables de configuration avec métadonnées.
| Localisation | `LocaleController` / `LocaleService` servent les locales distantes (JSON) consommées par le front.
| Transport chiffré | `CryptController`, `CryptService`, `CryptSessionService` et `TransportCryptInterceptor` gèrent la négociation ECDH et l'AES-256-GCM pour toutes les réponses HTTP comportant `x-crypt-session`.
| Redis partagé | `RedisService` expose **un** client `ioredis` partagé pour tout le backend (PERFORMANCE_PLAN.md §7.9). Voir « Redis partagé » plus bas.
| Notifications | `ProwlService` publie des alertes push via l'API Prowl.
| Email | `EmailService` envoie des emails via Brevo (SMTP relay) ou un serveur SMTP custom, configurable depuis l'admin via `emailConfigSchema`. Le transport est recréé automatiquement lorsqu'un paramètre change.
| Démarrage HTTP | `bootstrap/configureHttpApp.ts` : `configureHttpApp(app, options?)` applique le durcissement commun (voir « Démarrage HTTP » plus bas). |
| Santé | `HealthController` : `GET /api/v1/health` public, agrège les contributeurs `HEALTH_CONTRIBUTORS`. |
| Stockage d'images | `ImageStorageService` écrit sur disque local (défaut) ou sur un bucket Cloudflare R2, configurable depuis l'admin via `storageConfigSchema`. Voir « Stockage R2 » plus bas.

## Intégrations clés
- `TypeOrmModule.forFeature([ConfigurationEntity])` doit rester importé pour fournir les repositories utilisés par les services.
- L'interceptor `TransportCryptInterceptor` est enregistré globalement (`APP_INTERCEPTOR`). Toute route sensible profitera donc du chiffrement sans configuration supplémentaire, sauf celles marquées `@NoTransportCrypt()` (voir « Exemption sélective » plus bas).
- L'interceptor `CacheControlInterceptor` est également enregistré globalement (`APP_INTERCEPTOR`) mais n'agit que sur les routes marquées `@CacheControl(...)` — aucun effet ailleurs.
- Les autres modules importent `CommonModule` pour réutiliser `ConfigurationService`, `LocaleService`, `CryptService`, etc.

## Endpoints exposés (exhaustif)

### Configuration (`ConfigurationController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/configurations` | Public | Récupère la configuration applicative. **Exemptée du chiffrement de transport** (`@NoTransportCrypt`, décision C — voir plus bas) ; `Cache-Control: public, max-age=60, stale-while-revalidate=600` (durées configurables). |
| `PUT` | `/api/v1/configurations` | User | Met à jour la configuration. |

### Module Config (`ModuleConfigController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/module-configs/schemas` | Admin | Récupère tous les schémas de configuration de modules. |
| `GET` | `/api/v1/admin/module-configs` | Admin | Récupère tous les modules avec leurs valeurs actuelles. |
| `GET` | `/api/v1/admin/module-configs/:moduleId` | Admin | Récupère un module avec ses valeurs. |
| `GET` | `/api/v1/admin/module-configs/:moduleId/secret/:key` | Admin | Déchiffre et renvoie la valeur d'un champ `secret` donné (`{ value }`). |
| `PUT` | `/api/v1/admin/module-configs/:moduleId` | Admin | Met à jour les valeurs de configuration d'un module. |

### Session admin (`AdminSessionController`, enregistré par `AuthCoreModule`, pas par `CommonModule`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin-session` | Admin | Renvoie `{ admin: true, mode }` (`mode` = `users` \| `anonymous`). Sert au front (`AdminTokenGate`) à valider la clé admin. |

### Locales (`LocaleController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/locales/:category` | Public | Récupère les traductions pour une catégorie donnée. **Exemptée du chiffrement de transport** (`@NoTransportCrypt`, appliqué au niveau classe — voir plus bas) ; `Cache-Control: public, max-age=300, stale-while-revalidate=86400`. |
| `GET` | `/api/v1/locales` | Public | Toutes les catégories, toutes langues confondues. Query `?lang=fr` (optionnel) : ne renvoie que cette langue (`{ fr: {...} }`) au lieu de toutes — le front ne charge que la langue active au boot (PERFORMANCE_PLAN.md §1.3), et bascule sur l'autre à la demande (`LocaleService.ensureLangLoaded`, voir README front `reactcommon/common`). Payload mémoïsé côté service (TTL 5 min) — voir `LocaleService.getAllLocales`. **Exemptée du chiffrement de transport** ; `Cache-Control` idem ci-dessus. `?lang=` fait partie de l'URL donc du cache key (pas de `Vary` nécessaire). |

### Transport chiffré (`CryptController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/crypt/session` | Public | Initie une session de chiffrement ECDH (échange de clés publiques). |

#### Compression avant chiffrement (compress-then-encrypt)
`TransportCryptInterceptor` peut deflater le JSON **avant** l'AES-GCM (PERFORMANCE_PLAN.md §2.3) — un
ciphertext base64 étant incompressible, `app.use(compression())` ne peut rien faire une fois le payload
chiffré, donc la compression doit avoir lieu en amont, sur le clair.

- **Négociation (obligatoire, pas opportuniste)** : le client envoie l'en-tête de requête
  `x-crypt-accept-encoding` sur chaque appel chiffré (voir `TRANSPORT_ACCEPT_ENCODING_HEADER` dans
  `crypt.constants.ts`) :
  - absent → client legacy (bundle front antérieur à cette évolution) : le serveur répond toujours au
    format `v1` (4 segments, jamais compressé) ;
  - `identity` → client conscient du format `v2` mais dont le navigateur n'a pas `DecompressionStream`
    (~4 % du trafic, vérifié le 2026-09-07) : format `v2`, jamais compressé ;
  - `deflate` → client capable de décompresser : format `v2`, compressé si le clair dépasse
    `common_transport_deflate_threshold`.
- **Format de payload auto-descriptif** : `CryptService.encryptForTransport`/`decryptFromTransport`
  distinguent les deux versions par le nombre de segments séparés par `:` — 4 segments = `v1` (legacy,
  jamais compressé), 5 segments = `v2` (`version:flag:iv:cipher:tag`, `flag` = `0`/`1`). Les deux formats
  sont acceptés en déchiffrement des deux côtés (back ET front `reactcommon`), pour survivre à un
  déploiement où un bundle front en cache navigateur parle à un back déjà à jour, ou l'inverse.
- **Format de compression** : `zlib.deflateSync`/`inflateSync` côté Node — format zlib (RFC1950),
  l'exact pendant de `DecompressionStream('deflate')` côté navigateur. **Pas** `deflate-raw` (RFC1951) ni
  `gzip` (RFC1952) — une confusion ici casse le déchiffrement en silence (voir le test dédié dans
  `CryptService.spec.ts`).
- **Seuil configurable** : `common_transport_deflate_threshold` (Module Config Schema, groupe
  `performance`, défaut `1024` octets) — même principe que `common_gzip_threshold` pour la compression
  HTTP classique.
- La compression reste sans effet sur l'anti-pompage : le payload sur le fil demeure un ciphertext opaque
  de bout en bout, seul son contenu (compressible ou non) change avant chiffrement.

#### Exemption sélective du chiffrement + `Cache-Control` (décision C, PERFORMANCE_PLAN.md §2.0/§2.1)
`TransportCryptInterceptor` chiffre par défaut toute réponse portant `x-crypt-session`. Trois routes
d'infrastructure, ne portant aucune donnée métier, en sont exemptées via un décorateur dédié :
- **`@NoTransportCrypt()`** (`common/decorators/NoTransportCrypt.ts`) : posé sur une méthode ou une
  classe de contrôleur, lu par `TransportCryptInterceptor` via
  `Reflector.getAllAndOverride(NO_TRANSPORT_CRYPT_KEY, [handler, class])` — même patron que
  `@RequireFeature`/`FeatureGuard`. L'exemption court-circuite aussi le lookup Redis
  (`CryptSessionService.peekSession`) : ces routes ne paient plus le `GET` par requête. Liste
  exhaustive et fermée (ne pas en ajouter sans mettre à jour PERFORMANCE_PLAN.md §2.0) :
  `GET /api/v1/health`, `GET /api/v1/configurations`, `GET /api/v1/locales[/:category]`, `GET /api/v1/indicators/available`
  (module `blockchainIndicator`, décorée au niveau méthode uniquement). Toute route de **valeurs**
  (`/indicatorvalues/**`, séries du workshop) reste chiffrée.
- **`@CacheControl({ visibility, maxAgeConfigKey, staleWhileRevalidateConfigKey?, vary? })`**
  (`common/decorators/CacheControl.ts`) + **`CacheControlInterceptor`** (nouvel `APP_INTERCEPTOR`
  global, `CommonModule`) : pose l'en-tête `Cache-Control`, durées résolues à la requête depuis le
  Module Config Schema (jamais en dur). N'a de sens qu'associé à `@NoTransportCrypt()` — un
  ciphertext étant unique par requête (IV aléatoire), un `Cache-Control` dessus ne cache rien de
  réutilisable. `visibility: 'private'` doit être utilisé dès que la réponse varie par visiteur
  (ex. `/indicators/available`, dont le champ `locked` dépend du token optionnel résolu) même si la
  route elle-même est publique/anonyme. ⚠️ `private` **ne suffit pas** dans ce cas : il interdit
  seulement aux caches *partagés* de stocker la réponse, pas au cache du navigateur de rejouer une
  réponse anonyme pour une requête authentifiée ultérieure sur la même URL. Toute route `private`
  dont le payload dépend de l'identité doit donc déclarer `vary: ['Authorization']` — l'interceptor
  l'ajoute via `response.vary()` (append, ne écrase pas un `Vary: Origin` posé par CORS), ce qui
  sépare l'entrée de cache anonyme de l'entrée authentifiée.
- Tests : `TransportCryptInterceptor.spec.ts` (bloc « `@NoTransportCrypt()` exemption ») prouve
  qu'une requête avec `x-crypt-session` sur une route exemptée revient en clair (pas de
  `x-crypt-encrypted`, pas d'appel à `peekSession`) tandis qu'une route non exemptée reste
  chiffrée. `CacheControlInterceptor.spec.ts` couvre le format de l'en-tête.

### Santé (`HealthController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | Public | Sonde de vivacité pour Docker/compose et la supervision externe. Réponse `{ status: 'ok' \| 'degraded' \| 'down', timestamp, uptime, version, checks }` ; `checks` contient une entrée par contributeur (`{ <key>: { status, ...détails } }`). **Exemptée du chiffrement de transport** (`@NoTransportCrypt`, route d'infrastructure sans donnée métier). 200 sauf si un contributeur est `down` (ou lève une erreur, ou ne répond pas en 3 s) : 503. `degraded` reste 200. |

Sans contributeur, la route répond `{ status: 'ok', checks: {} }` : un projet public seul a donc un healthcheck valide. `version` vient de `APP_VERSION`, sinon `npm_package_version`, sinon `unknown`.

**Point d'extension `HEALTH_CONTRIBUTORS`** (`types/ExtensionPoints.ts`) : un module qui sait sonder quelque chose fournit un `HealthContributor { key, check() }` (ou un tableau) sous ce token (`{ provide: HEALTH_CONTRIBUTORS, useExisting: MonContributeur }`) et l'exporte depuis un scope global ; `HealthController` l'injecte en `@Optional()`. Un seul fournisseur du token par projet (celui du dernier module chargé l'emporte) : un module qui a plusieurs sondes fournit un tableau. **Une seule route `/api/v1/health` doit exister** : un module ne déclare jamais son propre contrôleur sur ce chemin (`infra` fournit le contributeur `infra`, plus de contrôleur). Exemple : `infra` (vx-private).

### Email (`EmailController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/admin/email/test` | Admin | Envoie un email de test à l'adresse fournie (`{ to: string }`). Retourne `{ success, messageId?, error? }`. |

### Cookie consent (`CookieConsentController`)
| Méthode | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/v1/cookie-consent` | Public | Journalise un choix de consentement (`{ categories: { necessary: true, audienceMeasurement: boolean } }`) — preuve de consentement CNIL, anonyme (pas de résolution d'utilisateur, `userId` toujours `null` aujourd'hui — voir `CookieConsentController`). Appelé en fire-and-forget par `CookieConsentBanner`/`CookieConsentSettingsModal` (front), erreurs ignorées côté client. |

## Configuration requise
- Variables d'environnement Prowl : `PROWL_API_KEY`, `PROWL_API_URL` (optionnel), `PROWL_APPLICATION_NAME`.
- **Email** : Configuré via le Module Config Schema (`emailConfigSchema`, groupe `email`). Clés de configuration :

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `common_email_provider` | select | `none` | Fournisseur : `none`, `brevo`, `mailjet`, `smtp` |
| `common_email_fromAddress` | string | _(vide)_ | Adresse expéditeur |
| `common_email_fromName` | string | _(vide)_ | Nom affiché de l'expéditeur |
| `common_email_brevoApiKey` | secret | _(vide)_ | Clé API Brevo |
| `common_email_brevoUser` | string | _(vide)_ | Login Brevo |
| `common_email_mailjetApiKey` | string | _(vide)_ | Clé API publique Mailjet (identifiant SMTP) |
| `common_email_mailjetSecretKey` | secret | _(vide)_ | Clé secrète Mailjet (mot de passe SMTP) |
| `common_email_smtpHost` | string | _(vide)_ | Hôte SMTP |
| `common_email_smtpPort` | number | `465` | Port SMTP (1–65535) |
| `common_email_smtpSecure` | boolean | `true` | Connexion TLS |
| `common_email_smtpUser` | string | _(vide)_ | Utilisateur SMTP |
| `common_email_smtpPassword` | secret | _(vide)_ | Mot de passe SMTP |
| `common_email_brevoRestApiKey` | secret | _(vide)_ | Clé `xkeysib-…` de l'API v3 Brevo. **Distincte de la clé SMTP** : le relais authentifie avec une clé SMTP, l'API REST attend cette clé dans un en-tête `api-key`. Requise pour les statistiques et le solde de crédits. |
| `common_email_maxConnections` | number | `5` | Connexions SMTP ouvertes en parallèle (pool nodemailer). |
| `common_email_ratePerSecond` | number | `10` | Débit maximal appliqué de notre côté. Aucun prestataire ne publie de limite SMTP exploitable : leurs réponses 4xx sont le vrai signal de contre-pression. |
| `common_email_monthlyAllowance` | number | `0` | Quota mensuel du forfait, utilisé pour calculer un solde quand le prestataire n'en expose pas (cas Mailjet). `0` = ne rien afficher. |
| `common_email_costPer1000` | number | `0` | Prix pour 1 000 envois, servant à l'estimation affichée avant un envoi. |
| `common_email_currency` | string | `EUR` | Devise de l'estimation. |
| `common_email_webhookSecret` | secret | _(vide)_ | Chaîne placée dans l'URL de rappel du prestataire. |

- **Identité du site & réseaux sociaux** : `brandConfigSchema`, groupes `brand` et `social`. Le backend n'avait auparavant **aucune** URL absolue (`VITE_APP_URL` existe côté front mais n'est jamais lu), ce qui rendait tout lien généré inutilisable dans un e-mail.

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `common_brand_siteUrl` | string | _(vide)_ | Racine publique du site, sans barre oblique finale. Base de tous les liens absolus vers une page front (recherche, désinscription, mentions légales…). |
| `common_brand_apiUrl` | string | _(vide)_ | Racine publique du backend, sans barre oblique finale. Repli sur `common_brand_siteUrl` si vide. Base des liens qui doivent résoudre sur le backend (pixel d'ouverture, suivi de clic, webhook fournisseur, images CMS) — nécessaire dès que front et back ne partagent pas le même domaine. |
| `common_brand_siteName` | string | _(vide)_ | Nom affiché en en-tête d'e-mail. |
| `common_brand_logoUrl` | string | _(vide)_ | Absolue ou relative au site. |
| `common_brand_headerBannerUrl` | string | _(vide)_ | Absolue ou relative au site. Bannière pleine largeur affichée en en-tête d'e-mail à la place du logo + nom du site quand elle est renseignée — voir `renderDefaultHeaderContent()` ci-dessous. |
| `common_brand_accentColor` | string | `#F4B000` | Couleur `#RRGGBB` des éléments mis en avant. |
| `common_brand_legalLine` | string | _(vide)_ | Mention légale du pied d'e-mail. |
| `common_brand_postalAddress` | string | _(vide)_ | Adresse postale du pied d'e-mail (exigée par la plupart des législations anti-spam). |
| `common_social_x` / `_youtube` / `_linkedin` / `_instagram` / `_telegram` / `_discord` | string | _(vide)_ | URL de profil. Une clé vide n'affiche rien. |

- **Stockage R2** : `storageConfigSchema`, groupe `storage`. Sélectionne où `ImageStorageService` écrit une image uploadée depuis `RichTextEditor` (entête/pied de page d'un motif, corps d'une communication, description de palier — tout appelant de `InlineImageController`/`ImageStorageService`).

| Clé | Type | Défaut | Description |
| --- | --- | --- | --- |
| `common_storage_provider` | select | `local` | `local` (disque, volume `SHARED_DIRECTORY`) ou `r2` (bucket Cloudflare R2). |
| `common_storage_r2_accountId` | string | _(vide)_ | Account ID Cloudflare (tableau de bord → R2). |
| `common_storage_r2_accessKeyId` | string | _(vide)_ | Access Key ID du jeton API R2 (permission Object Read & Write, scopé au bucket). |
| `common_storage_r2_secretAccessKey` | secret | _(vide)_ | Secret Access Key du même jeton — affiché une seule fois par Cloudflare à sa création. |
| `common_storage_r2_bucket` | string | _(vide)_ | Nom du bucket R2. |
| `common_storage_r2_publicBaseUrl` | string | _(vide)_ | Domaine personnalisé connecté au bucket (recommandé — `r2.dev` n'est pas garanti pour de la production par Cloudflare) ou son URL `r2.dev`. Sert de préfixe aux URLs renvoyées après upload. |

`local` reste le défaut : aucun changement de comportement pour une app qui ne configure rien. Passer à `r2` n'affecte que les **nouveaux** uploads — les fichiers déjà écrits sur disque restent servis tels quels par `GET /api/v1/inline-image/:filename` (`InlineImageController`, module `user`), jamais lus depuis R2. Motivation : un volume Docker nommé (`SHARED_DIRECTORY` → `/app/shared`) est partagé entre les *replicas* d'un même hôte, jamais entre plusieurs hôtes physiques distincts — un fichier écrit via une requête tombée sur l'hôte A serait invisible depuis l'hôte B. `POST /api/v1/admin/inline-image` renvoie désormais `{ filename, url }` : `url` est l'URL publique R2 (`ImageStorageService.publicUrl()`) quand ce provider est actif, `null` sinon — le front (`InlineImageService.uploadInlineImage()`, README `user`) l'utilise directement au lieu de composer une URL vers ce backend, puisqu'un fichier R2 n'y est jamais joignable.

`BrandService` lit ces clés et expose `getIdentity()`, `getSiteUrl()`, `getApiUrl()`, `absoluteUrl(path)`, `apiAbsoluteUrl(path)`, `getSocialLinks()`. `absoluteUrl()`/`apiAbsoluteUrl()` renvoient une chaîne vide quand la racine correspondante n'est pas renseignée : l'appelant masque le lien plutôt que d'émettre un lien relatif mort.

`EmailLayoutService` construit la coquille HTML partagée par tous les e-mails sortants (en-tête de marque, carte de contenu, pied sombre avec réseaux, mentions légales et désabonnement). Volontairement en tables avec styles inline : les clients de messagerie ne sont pas des navigateurs — Outlook ignore flexbox et grid, Gmail supprime les blocs `<style>` et le SVG inline, plusieurs clients abandonnent les feuilles externes. Les réseaux sont rendus en `<img>` pointant sur `<siteUrl>/images/social/<clé>.png` : le raster est la seule forme d'icône que tous les clients affichent, d'où la génération au build côté app (`npm run icons:social`). Chaque image porte le nom du réseau en `alt`, donc une app sans jeu d'icônes dégrade en lien texte lisible plutôt qu'en image cassée.

`EmailLayoutOptions` accepte désormais `headerHtml?`/`footerHtml?` : quand l'un est non-vide, `wrap()` l'utilise **verbatim** dans la ligne en-tête/pied plutôt que de générer la coquille générique (consommé par `CommunicationRenderService` du module `user`, pour le chrome par-topic — `templateHeader`/`templateFooter` de `CommunicationTopicEntity`, voir README du module `user`). Le contenu générique lui-même est désormais exposé par deux méthodes **publiques** (auparavant privées), réutilisables aussi bien pour le rendu réel par destinataire que pour amorcer un contenu par défaut ailleurs (ex. le seed de template d'un topic) : `renderDefaultHeaderContent(): string` et `renderDefaultFooterContent(options: EmailLayoutOptions): string`. `renderDefaultHeaderContent()` affiche la bannière `common_brand_headerBannerUrl` (pleine largeur, `${CONTENT_WIDTH}px` max) quand elle est configurée ; sinon elle retombe sur la composition logo + nom du site. `EmailLayoutOptions` accepte aussi `headerBackgroundColor?`/`footerBackgroundColor?` (`#RRGGBB`) : couleur de fond appliquée sur la `<td>` de la ligne, indépendamment du `headerHtml`/`footerHtml` — vide/absent conserve le fond générique (transparent pour l'en-tête — la seule valeur exportée pour l'en-tête, `DEFAULT_HEADER_BACKGROUND` = `#17140f`, n'amorce que le seed d'un nouveau topic, elle n'est pas appliquée en repli système ici ; `DEFAULT_FOOTER_BACKGROUND` — exporté, `#17140f` — pour le pied, celui-ci toujours appliqué en repli). `EmailLayoutService` reçoit désormais aussi `LocaleService` en dépendance, pour `buildFooterLinks(lang: string): Promise<EmailLayoutFooterLink[]>` (déplacée depuis `CommunicationRenderService`, qui délègue maintenant ici) — construit les liens légaux/RGPD du pied de page (mentions légales, confidentialité, CGU) dans la langue demandée.

`wrap()` entoure désormais les lignes en-tête/pied de commentaires HTML marqueurs (`<!--email-header-start/end-->`, `<!--email-footer-start/end-->` — invisibles pour tout client mail) afin que `reapplyChrome(html: string, options: EmailLayoutOptions): string | null` puisse, sur un e-mail déjà entièrement composé (`renderedHtml`/`renderedByLocale` d'une `CommunicationEntity` déjà figée), remplacer uniquement ces deux lignes par un nouveau rendu — sans jamais toucher au corps entre les deux. Retourne `null` si les marqueurs sont absents (e-mail figé avant l'ajout de cette fonctionnalité — rien à remplacer). Consommée par `CommunicationRenderService.reapplyTopicChrome()` (module `user`) pour répercuter un topic edité sur ses communications déjà envoyées/préparées, à la demande explicite de l'admin — voir README du module `user`.

**Images responsives (entête, corps, pied de page).** `wrap()` (sur `bodyHtml`) et `renderHeaderRow()`/`renderFooterRow()` (sur `headerHtml`/`footerHtml`, y compris via `reapplyChrome()` qui régénère ces deux lignes seules) passent désormais leur contenu par `ensureResponsiveImages()` (privée, non exportée) : chaque `<img>` sans propriété CSS `max-width`/`height` se voit ajouter `max-width:100%;height:auto` dans son `style` (fusion propriété par propriété, jamais un écrasement total — un `style` déjà présent, y compris le pixel de tracking `width:1px;height:1px` ou la bannière générique déjà responsive, reste intact). Corrige une image insérée via `RichTextEditor` (`setImage({src, alt})` côté `common-react` ne fixe aucune taille) qui forçait sinon tout le tableau à 600px+ de large sur un viewport étroit (aperçu mobile de l'admin, client mail mobile réel) — corrige rétroactivement tout contenu déjà enregistré, sans réédition. `display` n'est ajouté que dans le cas « image seule » ci-dessous (jamais autrement) : un entête/pied de page en mode `imagesInline` (rangée d'icônes côte à côte) casserait sinon en `display:block`.

**Entête/pied de page réduit à une seule image : padding retiré.** `renderHeaderRow()`/`renderFooterRow()` détectent, via `extractSoleImage()` (privée), le cas où `headerHtml`/`footerHtml` ne contient rien d'autre qu'une image unique (typiquement le rendu `RichTextEditor` en mode `imagesInline` : `<p style="text-align:center"><img …></p>`, éventuellement enveloppée d'un `<a href>` pour une bannière cliquable). Dans ce cas, le `padding` de la ligne (`0 0 24px 0` en-tête, `28px 24px` pied de page par défaut) passe à `0`, et l'image reçoit `display:block` (sinon un `<img>` inline/inline-block laisse un fin filet de la couleur de fond apparaître sous l'image — l'espace réservé à la ligne de base du texte). Le `<p>` enveloppant est retiré (son margin par défaut recréerait sinon l'espace qu'on vient de retirer via le padding), mais le `<a href>` est conservé intact — une bannière cliquable le reste. Dès qu'il y a plus d'une image, ou du contenu en plus (texte, plusieurs paragraphes), le padding normal et `display` inchangé sont conservés — la détection ne se déclenche que sur le cas strict « une seule image, rien d'autre ».

`EmailProviderService` est le point d'entrée unique vers le prestataire actif (`MailjetProviderClient`, `BrevoProviderClient`, ou rien pour `none`/`smtp`). Il expose `buildSendHeaders()`, `getQuota()`, `estimateCost()`, `fetchEvents()`, `parseWebhook()` et `registerWebhook()`. **Mailjet n'expose aucun endpoint de solde de crédits** — vérifié contre `/myprofile`, `/user`, `/apikey`, `/apikeytotals` et `/sender` — d'où le champ `source` (`api` | `computed` | `unavailable`) que tout appelant doit afficher tel quel.

Relais utilisés par `EmailService` selon `common_email_provider` :

| Provider | Hôte SMTP | Port | `secure` | Identifiant | Mot de passe |
| --- | --- | --- | --- | --- | --- |
| `brevo` | `smtp-relay.brevo.com` | 587 | `false` (STARTTLS) | `common_email_brevoUser` | `common_email_brevoApiKey` |
| `mailjet` | `in-v3.mailjet.com` | 587 | `false` (STARTTLS) | `common_email_mailjetApiKey` | `common_email_mailjetSecretKey` |
| `smtp` | `common_email_smtpHost` | `common_email_smtpPort` | `common_email_smtpSecure` | `common_email_smtpUser` | `common_email_smtpPassword` |

---

## Module Configuration Schema

Le système de configuration de module permet à chaque module d'exposer ses propres variables de configuration avec métadonnées (type, validation, description, groupes). Ces configurations sont ensuite affichées dans l'interface d'administration en blocs dédiés par module.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Backend                                 │
├─────────────────────────────────────────────────────────────────┤
│  ModuleConfigRegistry  ←── register(schema)                     │
│         │                                                       │
│         ▼                                                       │
│  ModuleConfigService   ←── getModuleConfigWithValues()          │
│         │                  updateModuleConfig()                 │
│         ▼                                                       │
│  ModuleConfigController ── GET/PUT /v1/admin/module-configs     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                │
├─────────────────────────────────────────────────────────────────┤
│  ModuleConfigService   ←── getAllWithValues()                   │
│         │                  updateModuleConfig()                 │
│         ▼                                                       │
│  ConfigurationSettings ←── Composant React avec accordéons      │
│                            par module                           │
└─────────────────────────────────────────────────────────────────┘
```

### Types

Les types sont définis dans `types/ModuleConfigSchema.ts` :

```typescript
type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'json' | 'secret';

type ConfigFieldSchema = {
  key: string;           // Clé de configuration (ex: 'tokensApi_maxRetries')
  label: string;         // Label affiché dans l'UI
  description?: string;  // Description / aide
  type: ConfigFieldType; // Type de champ
  defaultValue?: any;    // Valeur par défaut
  required?: boolean;    // Champ requis
  options?: ConfigFieldOption[];  // Pour type 'select'
  validation?: ConfigFieldValidation;  // min/max/pattern
  group?: string;        // Groupe pour organiser les champs
  hidden?: boolean;      // Masque le champ dans l'UI générique (géré par une UI dédiée)
  visibleWhen?: { field: string; in: string[] };  // Visibilité conditionnelle — voir ci-dessous
};

type ModuleConfigSchema = {
  moduleId: string;      // ID unique du module (ex: 'tokensApi')
  moduleName: string;    // Nom affiché (ex: 'Token Data Sources')
  description?: string;  // Description du module
  icon?: string;         // Icône (ex: 'database', 'settings')
  fields: ConfigFieldSchema[];
};
```

### Comment exposer la configuration d'un module

#### 1. Créer le schéma de configuration dans le module

```typescript
// monModule/configSchema.ts
import { ModuleConfigSchema } from '../common/types/ModuleConfigSchema';

export const monModuleConfigSchema: ModuleConfigSchema = {
  moduleId: 'monModule',
  moduleName: 'Mon Module',
  description: 'Configuration de mon module',
  icon: 'settings',
  fields: [
    {
      key: 'monModule_pollingInterval',
      label: 'Polling Interval (ms)',
      description: 'Intervalle entre les requêtes',
      type: 'number',
      defaultValue: 60000,
      group: 'polling',
      validation: { min: 5000, max: 600000 },
    },
    {
      key: 'monModule_enabled',
      label: 'Activer le module',
      type: 'boolean',
      defaultValue: true,
      group: 'general',
    },
    {
      key: 'monModule_source',
      label: 'Source de données',
      type: 'select',
      defaultValue: 'api1',
      options: [
        { value: 'api1', label: 'API 1' },
        { value: 'api2', label: 'API 2' },
      ],
      group: 'sources',
    },
  ],
};
```

#### 2. Enregistrer le schéma au démarrage

Créer un service qui implémente `OnApplicationBootstrap` :

```typescript
// monModule/services/MonModuleConfigRegistration.ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleConfigService } from '../../common/CommonModule';
import { monModuleConfigSchema } from '../configSchema';

@Injectable()
export class MonModuleConfigRegistration implements OnApplicationBootstrap {
  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  onApplicationBootstrap(): void {
    this.moduleConfigService.register(monModuleConfigSchema);
  }
}
```

#### 3. Ajouter le service au module

```typescript
// monModule/MonModule.ts
@Module({
  imports: [CommonModule],
  providers: [
    MonModuleConfigRegistration,
    // ... autres providers
  ],
})
export class MonModule {}
```

#### 4. Utiliser les valeurs de configuration

```typescript
// Dans un service
@Injectable()
export class MonService {
  constructor(private readonly configService: ConfigurationService) {}

  getPollingInterval(): number {
    const value = this.configService.get('monModule_pollingInterval');
    return value ? Number(value) : 60000;
  }
}
```

### API Endpoints

| Méthode | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/admin/module-configs/schemas` | Récupère tous les schémas |
| GET | `/api/v1/admin/module-configs` | Récupère tous les modules avec valeurs actuelles |
| GET | `/api/v1/admin/module-configs/:moduleId` | Récupère un module avec ses valeurs |
| GET | `/api/v1/admin/module-configs/:moduleId/secret/:key` | Déchiffre et renvoie la valeur d'un champ `secret` (`{ value }`) |
| PUT | `/api/v1/admin/module-configs/:moduleId` | Met à jour les valeurs d'un module |

### Seeding automatique des valeurs par défaut

Le `ModuleConfigSeederService` insère automatiquement les valeurs par défaut dans la table `config` au démarrage de l'application. Ce seeding s'exécute après l'enregistrement des schémas par les modules.

**Comportement :**
- Parcourt tous les schémas enregistrés dans `ModuleConfigRegistry`
- Pour chaque champ ayant un `defaultValue`, vérifie si la clé existe déjà en base
- Si la clé n'existe pas, insère la valeur par défaut sérialisée
- Les valeurs existantes ne sont jamais écrasées

**Sérialisation des types :**
- `boolean` → `'true'` / `'false'`
- `number` → `String(value)`
- `json` / `multiselect` → `JSON.stringify(value)`
- autres → `String(value)`

### Convention de nommage des clés

**Important** : Les clés de configuration doivent être préfixées par l'ID du module pour éviter les conflits :

```
{moduleId}_{configKey}
```

Exemples :
- `tokensApi_maxRetries`
- `tokensApi_defaultPollingInterval`
- `commerce_defaultCurrency`

---

## Démarrage HTTP (`bootstrap/`)

`configureHttpApp(app, options?)` est appelée par `template/back/src/main.ts` **avant `app.init()`** (les middlewares doivent précéder les parseurs de Nest et le routeur, sinon un preflight CORS répond 404) ; une app qui a un `main.ts` personnalisé l'appelle de la même façon. Elle applique, dans l'ordre : `trust proxy`, `helmet` (CSP désactivée : l'API sert du JSON et Swagger, le front pose sa propre CSP), CORS, capture du `rawBody`, limites de corps, `ValidationPipe({ whitelist: true, transform: true })` global. Elle **lève** une erreur (au lieu de quitter) sur une configuration dangereuse : `main.ts` laisse le rejet de `bootstrap()` arrêter le processus. Elle retourne les options résolues. `resolveListenHost()` renvoie l'hôte d'écoute.

| Variable | Défaut | Effet |
| --- | --- | --- |
| `CLIENT_ORIGINS` | `http://localhost:<FRONT_PORT>` | Liste CORS séparée par des virgules. `*` reflète toute origine sans credentials ; **refusé** avec `NODE_ENV=production`. |
| `HOST` | `0.0.0.0` | Adresse d'écoute (`resolveListenHost`). |
| `TRUST_PROXY` | `1` en production, désactivé sinon | `true`, `false`, nombre de sauts ou nom de sous-réseau (`loopback`). Nécessaire pour un `req.ip` correct derrière nginx. |
| `RAW_BODY_PATHS` | `/webhook` | Fragments de chemin dont le corps JSON est aussi disponible en `req.rawBody` (signatures de webhooks), limite 50 Mo. Correspondance par sous-chaîne sur le chemin sans query string. Les autres routes : 5 Mo. |

Limites ajustables par option (`jsonLimit`, `rawBodyLimit`). Tests : `bootstrap/configureHttpApp.spec.ts`.

## Services exportés

| Service | Description |
| --- | --- |
| `ConfigurationService` | Lecture/écriture de la configuration applicative (DB). |
| `ConfigSeederService` | Seed des valeurs par défaut de configuration au bootstrap. |
| `ConfigurationMapper` | Sérialisation des entités de configuration. |
| `LocaleService` | Chargement et merge des fichiers de traduction. `translate(key, lang, params?)` traduit une clé côté serveur (nécessaire pour ce que le backend rend lui-même : corps d'e-mails), avec cache en mémoire et `clearTranslationCache()`. Une clé absente est renvoyée telle quelle, délibérément : une traduction manquante doit se voir. `getAllLocales(lang?)` (utilisée par `GET /api/v1/locales`) mémoïse le payload fusionné (TTL 5 min, `clearAllLocalesCache()` pour forcer un refresh) au lieu de re-scanner/re-lire/re-parser ~345 Ko de JSON à chaque appel HTTP (PERFORMANCE_PLAN.md §1.3) ; `lang` filtre le résultat mémoïsé sans re-scanner le disque. |
| `ProwlService` | Envoi de notifications push via l'API Prowl. |
| `EmailService` | Envoi d'emails via Brevo, Mailjet ou SMTP custom. Méthodes : `sendEmail(to, subject, html, options?)`, `sendTestEmail(to)`, `getProvider()`. `options` accepte `headers` (corrélation prestataire) et `text` (alternative texte, qui améliore sensiblement la délivrabilité en masse) ; le résultat porte `messageId` et `response`. Le transport est mutualisé (pool) et débité selon `common_email_maxConnections` / `common_email_ratePerSecond`. |
| `BrandService` | Identité du site : `getIdentity()`, `getSiteUrl()`, `getApiUrl()`, `absoluteUrl(path)`, `apiAbsoluteUrl(path)`, `getLogoUrl()`, `getAccentColor()`, `getSocialLinks()`. |
| `EmailLayoutService` | Coquille HTML des e-mails sortants : `wrap(bodyHtml, options)` (`options.headerHtml?`/`footerHtml?` remplacent la coquille générique quand non-vides), `renderButton(label, url)`, `renderArticleCard(article, accentColor)`, `renderDefaultHeaderContent()`, `renderDefaultFooterContent(options)`, `buildFooterLinks(lang)`, `reapplyChrome(html, options)`. Helpers exportés : `escapeHtml`, `escapeAttr`, `truncateWords`. |
| `EmailProviderService` | Façade du prestataire actif : `buildSendHeaders()`, `getQuota()`, `estimateCost(n)`, `fetchEvents(campaignRef, since)`, `parseWebhook(provider, payload)`, `registerWebhook(apiPrefix)`, `getWebhookSecret()`, `buildWebhookUrl(apiPrefix)`. |
| `CryptService` | Utilitaires de chiffrement AES-256-GCM. |
| `RedisService` | Client `ioredis` partagé — voir « Redis partagé » ci-dessous. |
| `CryptSessionService` | Gestion des sessions ECDH. |
| `ModuleConfigRegistry` | Registre en mémoire des schémas de configuration de modules. |
| `ModuleConfigService` | CRUD des valeurs de configuration de modules (DB). |
| `ModuleConfigSeederService` | Seed automatique des `defaultValue` des schémas enregistrés. |
| `CronLockService` | Verrou de cron + table `polling_lock`. **Postgres** : advisory-locks (`pg_try_advisory_xact_lock`) ; `runExclusive(key, fn)` (une seule instance exécute le callback dans la transaction du lock) et `runIfDue(key, intervalMs, fn)` (throttle cross-instance, lock relâché **avant** le callback). **SQLite** (détecté sur le pilote du `DataSource`) : verrou **en mémoire du processus** (ensemble de clés tenues, non bloquant), donc une **seule instance** applicative par base ; la table `polling_lock` (dates ISO-8601 UTC) conserve les délais entre redémarrages. Aussi : `markRun(key)` (marque « exécuté maintenant », insert ou update), `clearLastRun(key)`, `getLastRunAt(key)`, `getLastRunAts(keys)` — portables, utilisés par `DiskAlertService`. Les requêtes brutes à placeholders `$n` passent par `portableQuery` (`utils/dbEngine.ts`), qui les convertit en `?` sous SQLite. |
| `InstanceRoleService` | Résout le rôle du process via `NODE_ROLE` (`worker` défaut \| `api`). `isWorker()` / `isApi()` / `role`. |
| `ImageStorageService` | Stockage générique d'images, **deux providers** sélectionnés par `common_storage_provider` (voir `storageConfigSchema` ci-dessous) : `local` (défaut, inchangé) écrit sur le volume partagé (`SHARED_DIRECTORY`, repli `/app/shared` en prod / `tmp/shared` en dev) ; `r2` envoie vers un bucket Cloudflare R2 (S3-compatible, `@aws-sdk/client-s3`) servi directement depuis son URL publique — voir la section « Stockage R2 » plus bas. `write(namespace, baseName, file)` (valide mimetype png/jpeg/webp et taille ≤ `IMAGE_MAX_BYTES` = 5 Mo, retourne le nom de fichier stocké — même contrat quel que soit le provider) / `read(namespace, filename)` (résout le chemin absolu + `mimeType`, `null` si absent — **disque local uniquement**, jamais consultée pour un fichier R2) / `publicUrl(namespace, filename)` (URL publique R2, `null` si provider `local`) / `getProvider()`. Namespace-scopé pour que des appelants indépendants ne collisionnent pas (ex. `user-inline` pour `InlineImageController`, `user-avatar` pour les avatars — les deux dans le module `user`). Volontairement générique — pas de logique métier — pour être réutilisé par n'importe quel module ayant besoin de stocker des images issues d'un upload, sans dépendre d'une notion de propriétaire (contrairement à `CmsArticleService`, qui garde sa propre implémentation similaire mais scopée à un article). Les avatars (2026-09-14, `UserService.saveAvatar`/`getAvatarFile`, `UserInfoMapper.avatarUrl`) utilisent un nom de fichier **déterministe** (`${userId}${ext}`, réutilisé à chaque nouvel upload) au lieu du nom unique horodaté d'`InlineImageController` — ils passent donc un `cacheControl` court explicite à `write()` plutôt que le défaut d'un an immuable (voir le commentaire de `write()` : un appelant qui réutilise un nom de fichier DOIT le faire, sous peine de resservir les anciens octets pendant un an après un remplacement). |
| `CookieConsentService` / `CookieConsentRetentionCronService` (2026-09-14) | Système de consentement cookies, générique comme `ImageStorageService` (pas de propriétaire métier). `CookieConsentEntity` (`cookie_consent_log`) est une table **append-only** (une ligne par action banner/modale, jamais mise à jour) — preuve de consentement CNIL. `CookieConsentService.log({ip, userAgent, categories})` fait l'insertion, appelée par `CookieConsentController` (voir endpoints ci-dessus). `CookieConsentRetentionCronService` (même pattern que `UserAnonymizationCronService` du module `user` : `@Cron(EVERY_DAY_AT_3AM)` + garde `InstanceRoleService.isWorker()` + `CronLockService.runIfDue` pour survivre à un redémarrage) supprime les lignes de plus de **6 mois** — durée de validité du consentement CNIL, identique au `Max-Age` du cookie client `vx_cookie_consent` (`front/.libs/reactcommon/common/utils/cookieConsent.ts`) pour que le bandeau se re-déclenche exactement quand la ligne de preuve correspondante sort de la fenêtre de rétention. Aucune infrastructure de mesure d'audience n'est câblée à ce jour (aucun outil choisi) — `hasConsent('audienceMeasurement')` (front) est le point de contrôle prêt à l'emploi pour un futur chargement conditionnel de script, qui devra lui-même plafonner ses propres cookies à **13 mois** (exemption CNIL mesure d'audience) — rien à appliquer aujourd'hui côté backend pour un script qui n'existe pas. Pas d'interface admin pour consulter `cookie_consent_log` (hors périmètre, à ajouter si un jour nécessaire pour répondre à un contrôle). |
| `AppExceptionFilter` | Filtre global d'exceptions HTTP. |
| `events/` (2026-09-23) | Flux d'événements **en pull** entre apps : `EventFeedEntityBase` (colonnes `id`/`type`/`payload` JSON portable — `jsonb` sur Postgres, `simple-json` sur SQLite —/`createdAt` d'une table outbox propre à chaque module), `appendFeedEvent`, `readEventFeed(repo, afterId, limit)` (`{ events, latestId }`, sans `afterId` = `latestId` seul), `purgeEventFeed(repo, jours)`. Côté consommateur, `RemoteEventFeedPollerService.poll({ feedId, url, onEvent })` : lit les événements après son curseur (Redis `event-feed-cursor:<feedId>`, mémoire à défaut), avance le curseur après chaque événement traité, démarre à `latestId` sans rejouer l'historique, ne lève jamais. Le producteur n'appelle jamais ses consommateurs. Utilisé par `wallet-intelligence` / `breakout-intelligence` et leurs `-remote`. |
| `utils/dbEngine.ts` | Utilitaires purs de moteur de base, sans dépendance au module `database` (qui les ré-exporte) : `resolveEngine`, `isSqlite`, `isSqliteDataSource`, types de colonnes portables `jsonColumnType()` / `timestampColumnType()` (`jsonb`/`timestamptz` en Postgres, `simple-json`/`datetime` en SQLite), `portableQuery` (SQL brut `$n` → `?` sous SQLite), `readConnectionEnv`, `MAIN_CONNECTION`. Les entités de `common` et de `voice` les importent d'ici : ne jamais importer `database` depuis `common`/`voice`. Tests : `sqlite.integration.spec.ts`, `portableEntities.spec.ts`. |
| `utils/throttledFetch.ts` (2026-09-22) | Protection générique pour tout appel HTTP sortant vers une API tierce (surtout les API gratuites/free-tier, qui imposent presque toujours un quota strict) : espacement minimal entre deux appels par `sourceId` + backoff exponentiel avec jitter sur 429/5xx, respecte l'en-tête `Retry-After` quand le transport peut le fournir. Ne jette jamais — `throttledFetchJson(sourceId, url, opts)` renvoie `{ data, stale, status, rateLimited }`. `opts.init` (2026-09-23) : méthode/en-têtes/corps pour le transport `fetch` par défaut (POST, en-tête d'auth). `opts.transport` est un point d'injection optionnel (`(url, signal) => Promise<{status, body, retryAfter?}>`) pour un appelant qui a déjà son propre transport testable (ex. les collecteurs `market-data`) au lieu du `fetch` réel par défaut. `resetThrottleBuckets()` (tests uniquement) vide l'état interne. Généralisé à partir de `market-data/utils/fetchJson.ts`, qui délègue maintenant ici et garde uniquement sa table d'intervalles par source et sa signature historique `RequestInit`. |
| `utils/rateLimitLedger.ts` (2026-09-22) | Ledger PROACTIF générique : plusieurs fenêtres nommées (`kind: 'rolling'` glissante en ms, ou `'calendar-day'` alignée sur minuit UTC) et plusieurs compteurs nommés par fenêtre (ex. `requests`, `tokens`), chacun optionnellement plafonné — sert à vérifier/décrémenter un budget **avant** l'appel (ex. router vers un autre credential plutôt que de déclencher un vrai 429). `rollRateLimitLedger`, `isUnderRateLimitLedger` (avec marge de sécurité `marginPct`), `applyRateLimitLedgerUsage` — toutes pures, l'appelant persiste lui-même l'état renvoyé (`RateLimitLedgerState`, sérialisable JSON). Généralisé à partir du ledger RPM/RPD/TPM/TPD de `llm-proxy/llmProxyRateLimitUtils.ts`, qui délègue maintenant ici en interne (signature externe inchangée — `LlmProxyCredentialService` et le schéma DB de `LlmProxyCredentialEntity` n'ont pas bougé). Toute nouvelle intégration avec un quota documenté de type "N requêtes/minute ou /jour" peut réutiliser ce fichier directement plutôt que de re-dériver la même logique de fenêtre glissante/calendaire. |
| `utils/CrossEnvDbConnection.ts` | Plumbing générique de connexion cross-environnement pour les actions admin de publication prod→preprod (ce n'est pas une classe injectable, un ensemble de fonctions exportées). `parseEnvFile(path)` (parseur minimal `KEY=VALUE`), `buildTargetConfig(envFilePath, certBaseDir)` (config `pg` depuis les variables `DB_*`, gère `DB_SSLMODE`/`DB_SSLROOTCERT`), `poolRunner(pool)` (adapte un `Pool` `pg` — dont `.query()` résout un `QueryResult`, pas un tableau — au contrat `Runner` que `DataSource.query()` respecte déjà nativement), `openTargetPool(dataSource, envFilePath, certBaseDir)` (ouvre le pool cible, refuse si host+database résolvent vers la connexion `dataSource` courante — protection contre une instance preprod qui publierait sur elle-même), `assertProductionEnvironment()` (2026-09-08 — lève une `BadRequestException` si `process.env.APP_ENV !== 'prod'`, à appeler en tout premier dans `preview()`/`publish()` : contrairement à `openTargetPool`, qui ne protège que contre l'auto-ciblage, celle-ci garantit que l'action ne peut être **déclenchée** que depuis le process prod lui-même, même via un appel direct de l'API qui contournerait le bouton désactivé côté front). **Postgres uniquement** (pool `pg` vers un autre environnement ; sans objet avec SQLite). Extrait de `workshop/services/GraphCrossEnvPublishService.ts` (module applicatif, historiquement le premier consommateur) pour être réutilisé par `cms/services/CmsCrossEnvPublishService.ts` sans dupliquer cette logique sensible (SSL, parsing de `.env`) — toute nouvelle action de publication cross-environnement doit s'appuyer dessus plutôt que la réécrire. |

## Authentification (port)

`common/auth/` découple l'authentification du module `user` : un module public n'a besoin que du port.
L'AppModule importe `AuthCoreModule.forRoot()` (voir « Plugins » pour le fournisseur `user`).

| Classe | Rôle |
| --- | --- |
| `AuthPort` / `AUTH_PORT` | Contrat : `mode: 'users' \| 'anonymous'` + `resolveToken(token): Promise<AuthPrincipal \| null>`. |
| `AuthPrincipal` | `{ id, admin, kind: 'user' \| 'admin-token' }` posé dans `req.user`. |
| `AnonymousAuthProvider` | Mode `anonymous` : seul identité = admin via `ADMIN_TOKEN` (comparaison à temps constant, principal `{ id: 0, admin: true, kind: 'admin-token' }`). `ADMIN_TOKEN` vide ou < 32 caractères ⇒ warn au démarrage et admin désactivé. |
| `GlobalAuthInterceptor` | Intercepteur global (`APP_INTERCEPTOR`). Ignore `@Public()`, idempotent si `req.user` existe. Mode `users` : token obligatoire (comportement de l'ancien `AuthInterceptor` de `user`). Mode `anonymous` : sans token la requête passe sans `req.user` ; token invalide ⇒ 401. Pose `req.user` + `uid`/`user` dans body/params/query. |
| `RequireUserInterceptor` | Routes propres à un utilisateur : 401 si pas de `req.user` ou `kind === 'admin-token'` (donc 401 en mode anonyme). |
| `RequireAuthInterceptor` | Tout principal authentifié (user **ou** admin-token) : équivaut à l'ancien `AuthInterceptor` en mode `users`, seul l'admin passe en mode `anonymous`. |
| `AdminOnlyInterceptor` | (existant) exige `req.user.admin`. |
| `AuthCoreModule.forRoot({ imports?, provider? })` | Module global : fournit `AUTH_PORT` (provider par défaut `AnonymousAuthProvider`), `GlobalAuthInterceptor` et `AdminSessionController`. |

Variable d'environnement : `ADMIN_TOKEN` (>= 32 caractères) — clé admin en mode anonyme, envoyée en `Authorization: Bearer`.

## Plugins

`common/plugins/NestModulePlugin.ts` définit le descripteur `NestModulePlugin { id, module?, auth? }` que chaque module lié peut exporter (`<module>/plugin.ts`, export `plugin`). L'AppModule importe les `module` listés ; au plus un plugin fournit `auth` (`AuthCoreOptions`), qui remplace le fournisseur anonyme dans `AuthCoreModule.forRoot(auth)`. Exemples : `user/plugin.ts` (fournisseur d'auth `UserAuthProvider`), `voice/plugin.ts`.

## Redis partagé (`RedisService`)

PERFORMANCE_PLAN.md §7.9 (prérequis au scaling horizontal) : **un seul** client `ioredis`
pour tout le backend — un seul cycle de vie, une seule politique de reconnexion, un seul
signal de santé. Généralise le pattern qu'avait `CryptSessionService` avant cette
évolution (son `initRedis()` ad hoc a été extrait ici à l'identique : mêmes options
`retryStrategy`/`reconnectOnError`/`maxRetriesPerRequest`).

- `getClient(): Redis | null` — `null` quand `REDIS_URL` n'est pas définie (ou si
  `ioredis` n'a pas pu être chargé). **Contrat fail-open obligatoire pour tout
  consommateur** : traiter `null` — et toute commande qui échoue plus tard sur un client
  non-null (panne transitoire) — comme « replier sur un comportement local/mémoire,
  journaliser », jamais comme une raison de faire échouer l'appelant. `RedisService`
  lui-même ne lance jamais d'exception.
- `isConfigured(): boolean` — un client existe (REDIS_URL était définie), sans garantir
  que la connexion est up à l'instant T.
- `isReady(): boolean` — connexion effectivement établie (`status === 'ready'`), pour un
  affichage de santé, pas comme garde par requête.
- `onModuleDestroy()` ferme proprement la connexion (`quit()`).

**Consommateurs actuels** : `CryptSessionService` (sessions de transport — repli mémoire
inchangé), le store de `ThrottlerModule` (`RedisFailOpenThrottlerStorage`, module `app`),
`SeriesAccessMetricsService` (`nestcommon/blockchainIndicator`, compteurs de détection
`HINCRBY`/HyperLogLog `PFADD`/`PFCOUNT`), et `RedisCacheStore` (a project-specific module,
cache des signaux résolus). Tous suivent le même contrat fail-open : sans `REDIS_URL`,
le comportement est strictement identique à avant l'introduction de Redis dans ce projet.

⚠️ **`REDIS_URL` n'est actuellement définie ni dans `back/.env` ni dans le service `back`
de `scripts/docker-compose.yml`** (alors qu'un conteneur `redis:7-alpine` y tourne) — donc
tout ce qui précède tourne aujourd'hui en mode 100 % dégradé (mémoire locale par
instance), en dev comme potentiellement en prod. Câbler Redis nécessite d'ajouter
`REDIS_URL=redis://redis:6379` (ou l'équivalent du nom de service compose) aux deux
endroits — décision de déploiement, hors périmètre de ce README.

## Rôle d'instance & gating du travail de fond (`InstanceRoleService`)

`NODE_ROLE` sépare les process en deux rôles (voir `ARCHITECTURE.md` §3 de l'app) :

- **`worker`** (défaut) : exécute tout le travail de fond (schedulers, moteurs, workers de run, feeds).
- **`api`** : sert l'HTTP uniquement ; `main.ts` supprime tous les jobs du `SchedulerRegistry` au
  démarrage, et le travail de fond non-décorateur est gaté par `isWorker()`.

**Convention pour un nouveau travail de fond :**

1. Travail piloté par `@Cron`/`@Interval`/`@Timeout` → rien à faire pour le gating API (les jobs
   sont supprimés sur le rôle `api`). Le worker l'exécute.
2. Travail dans `onModuleInit`/`onApplicationBootstrap`/`setInterval` brut (feeds, boucles) →
   injecter `InstanceRoleService` et `if (this.instanceRole.isApi()) return;`.
3. **Tâche singleton (non idempotente)** → l'envelopper dans `CronLockService` même avec un seul
   worker : un rolling deploy fait coexister brièvement deux workers. Choix de la primitive :
   - poller réseau / `@Interval` → `runIfDue(key, intervalMs, fn)` (pas de transaction tenue) ;
   - job DB court → `runExclusive(key, fn)` ;
   - job long / multi-statements → `runIfDue` (évite une longue transaction unique).

## Hooks pour une IA
- Pour ajouter un nouveau service transverse, l'exporter depuis `providers` et `exports` afin qu'il soit réutilisable par les autres modules.
- Les DTO/mappers sont situés dans `./dtos` et `./mappers` pour faciliter la sérialisation automatique.
- Pour exposer des variables de configuration d'un module : créer un `configSchema.ts`, un service d'enregistrement, et l'ajouter aux providers du module.
- Pour envoyer un email depuis un autre module : importer `CommonModule`, injecter `EmailService`, appeler `sendEmail(to, subject, html, options?)`.
