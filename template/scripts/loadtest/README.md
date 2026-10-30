# Test de charge (`scripts/loadtest`)

Outil générique de test de charge d'un environnement **déjà déployé** : simule des sessions simultanées (utilisateurs
enregistrés + visiteurs anonymes) par paliers, mesure en parallèle la santé des machines, de Postgres et de Redis, coupe
le test tout seul quand une limite est franchie, puis produit un rapport Markdown avec une extrapolation du point de
saturation. Disponible dans tous les projets (le dossier `scripts/` est lié depuis le template) ; **rien à câbler** :
ce n'est ni un module `nest/` ni un module `react/`.

Le moteur est générique. Tout ce qui est propre à un projet (URL, parcours, requêtes Prometheus, paliers) vit dans
`loadtest.config.json` à la racine du projet.

> **Lancer un test, pas à pas** : [`PROCEDURE.md`](PROCEDURE.md) — validation à blanc, armer, lancer, désarmer, nettoyer, analyser, dépannage, check-list.

## Principe

```
loadtest.mjs run ─┬─ k6 (scripts/loadtest/k6/scenario.js)  ──►  front, API, services annexes
                  ├─ échantillonneur (toutes les `sampleSec` s) ─► Prometheus · Postgres · Redis · générateur
                  └─ garde-fous : un seuil franchi ⇒ k6 s'arrête proprement (SIGTERM), le palier est marqué « aborted »
```

- **Modèle fermé** : une session = une boucle « choisir une page (pondérée) → ses requêtes → temps de réflexion ».
  Un palier est un nombre de **sessions simultanées** (`concurrent`), réparti entre enregistrés et anonymes (`model.mix`).
- **Comptes de test** : de vrais comptes créés par l'API admin du module `user`, chacun avec un jeton d'API statique
  (aucun flux de login à automatiser). Créés par `setup`, supprimés par `teardown`.
- **Aucun palier ne tourne sans être nommé** (`--tier`), et `run` exige `--confirm <hôte de l'API>` hors localhost.

## Prérequis

- Node ≥ 20 (le CLI n'a aucune dépendance : `pg` et `ioredis` sont pris dans le `node_modules` du `back/` du projet).
- [k6](https://k6.io) : `brew install k6` (macOS) ou le paquet officiel Linux.
- Un token **admin** de l'environnement cible (utilisateur technique admin, `POST /users/admin/technical` puis `/:id/api-token`).
- **Générateur** : le trafic simulé est faible (≈ 200 req/s pour 1000 sessions avec temps de réflexion) : un portable
  suffit tant qu'il est au calme (fermer navigateur et IDE lourds pendant un palier). Le CLI surveille la charge de la
  machine (`limits.generatorLoadRatio`, charge 1 min ÷ cœurs) et arrête le test si elle sature : des résultats mesurés
  sur un générateur chargé ne valent rien. Une VM jetable n'apporte que la proximité réseau avec la cible et la
  diversité d'IP (voir `model.generatorIps`).

## Démarrage rapide

```bash
node scripts/loadtest/loadtest.mjs init            # crée loadtest.config.json, .loadtest/secrets.env, .gitignore
$EDITOR .loadtest/secrets.env loadtest.config.json # secrets puis cibles / parcours
node scripts/loadtest/loadtest.mjs plan            # trafic estimé, opérations Redis, avertissements — rien n'est contacté
node scripts/loadtest/loadtest.mjs check           # lecture seule : k6, cibles, token, Prometheus/Postgres/Redis, baseline
node scripts/loadtest/loadtest.mjs setup           # crée les comptes de test + jetons (.loadtest/users.json, mode 600)
node scripts/loadtest/loadtest.mjs probe           # 1 GET par URL de parcours : valide chemins, droits et formats avant la charge
node scripts/loadtest/loadtest.mjs run --tier smoke --confirm api.example.com
node scripts/loadtest/loadtest.mjs throttle raise --tier u200 --tier u500   # si `plan` le demande (anonymes)
node scripts/loadtest/loadtest.mjs run --tier u200 --tier u500 --confirm api.example.com
node scripts/loadtest/loadtest.mjs teardown        # révoque les jetons, supprime les comptes, restaure le limiteur
```

### Où mettre les secrets

Dans **`.loadtest/secrets.env`** (créé par `init`, droits 600, ignoré par git) ou exportés dans le terminal. Jamais dans
`loadtest.config.json` (versionné), jamais dans une conversation.

| Variable | Rôle |
|---|---|
| `LOADTEST_ADMIN_TOKEN` | Token admin de l'API cible (`auth.adminTokenEnv`) : création/suppression des comptes. Jamais transmis à k6 |
| `LOADTEST_PROM_USER` / `LOADTEST_PROM_PASSWORD` | Basic auth du Prometheus interrogé |
| `LOADTEST_BYPASS_KEY` | Valeur de l'en-tête `x-loadtest-key` de la règle Cloudflare **posée à la main** (même valeur que dans la règle). Inutile si `cloudflare allow` l'a créée (il enregistre son secret). Sans l'un ou l'autre, les requêtes traversent la protection Cloudflare |
| `LOADTEST_PG_URL` | Connexion Postgres de supervision (sinon assemblée depuis les `DB_*` de `monitor.postgres.envFile`) |
| `LOADTEST_REDIS_URL` | Connexion Redis de supervision (sinon `REDIS_URL` de `monitor.redis.envFile`) |
| `CLOUDFLARE_API_TOKEN` | Token API Cloudflare avec **Zone → Zone → Read** et **Zone → Zone WAF → Edit** sur la zone testée, pour `cloudflare allow\|revoke`. Un token sans accès à la zone est refusé par `cloudflare check` |
| `CLOUDFLARE_ACCOUNT_ID` | Seulement pour un token *possédé par un compte* (vérifié sur `/accounts/<id>/tokens/verify` quand `/user/tokens/verify` le refuse) |

## Commandes

| Commande | Contacte la cible ? | Rôle |
|---|---|---|
| `init` | non | Crée config, dossier `.loadtest/` (700), `secrets.env`, entrée `.gitignore` |
| `plan [--tier n]` | non | Sessions, VUs, req/s, opérations Redis estimées par palier + avertissements |
| `check` | lecture seule | k6, `GET <api>/health`, présence du token, connexion Prometheus/Postgres/Redis, baseline sous les garde-fous, intervalle de scrape des jobs (`monitor.prometheus.jobs`), budget de connexions Postgres, limiteur resté relevé. Les ⚠ sont consultatifs |
| `setup [--count N] [--tier-id id\|nom]` | **écrit** | Choisit le tier (`auth.tier`, défaut `highest` = le tier public de plus haut niveau, via `GET /tiers/public`), crée les comptes `<prefix>-NNN` et leurs jetons ; reprenable (journal écrit après chaque compte) |
| `probe` | lecture | Une requête GET par **URL** de chaque parcours (toutes les variantes d'un `path` tableau ; POST ignorés), tableau de statuts. Les parcours enregistrés utilisent le premier compte de test |
| `run --tier <n>... --confirm <hôte>` | **charge** | Exécute les paliers listés, dans l'ordre, avec `monitor.cooldownSec` entre eux ; écrit le rapport. Refuse de démarrer si les paliers exigent un limiteur relevé et qu'il ne l'est pas (`--ignore-throttle` pour passer outre) |
| `report <runId>` | non | Régénère `report.md` d'un run (`.loadtest/runs/<runId>/`) |
| `teardown [--hard [--apply]]` | **écrit** | Révoque les `jti`, supprime les comptes via l'API admin et restaure le limiteur s'il a été relevé. `--hard` : suppression SQL (voir plus bas) |
| `throttle show\|raise\|restore` | **écrit** | Relève / restaure temporairement la limite globale du back (voir « Limiteur de débit ») |
| `cloudflare plan\|check\|allow\|revoke` | `allow`/`revoke` écrivent | Exception WAF temporaire (voir plus bas). `check` est en lecture seule |

Options communes : `--root <dir>`, `--config <fichier>`.

## `loadtest.config.json`

Fusionné avec les défauts de `lib/config.mjs` (un objet se fusionne clé par clé, un tableau remplace). Exemple minimal :
`loadtest.config.example.json`.

| Clé | Rôle |
|---|---|
| `targets` | `api` (obligatoire, **base incluant `/api/v1`**), `front`, et toute autre cible nommée utilisable par `step.target` |
| `headers` | En-têtes ajoutés : `all` et/ou par cible. Ne pas envoyer l'en-tête de transport chiffré/compressé si le back le négocie (`x-crypt-accept-encoding`) : la réponse reste en clair |
| `auth` | `userCount`, `prefix`, `tier` (`highest` \| `lowest` \| id \| nom ; défaut `highest`) ou `tierId` (id imposé), `userTable`/`nicknameColumn` (suppression SQL), `adminTokenEnv`, `paths` des routes admin |
| `model` | `mix` (somme = 1), `thinkSec` `[min, max]`, `avgPageSec`, `coldLoadRatio` `{ registered, anonymous }` (part des sessions qui téléchargent index + assets du front), `redisOpsPerRequest`, `crypt { enabled, acceptEncoding }` (chiffrement de transport, voir ci-dessous), `generatorIps` |
| `tiers` | `[{ name, concurrent, rampSec, holdSec, rampDownSec?, optional? }]` — défauts : `smoke` 5, `u50`, `u200`, `u500`, `u1000` (optionnel). Les montées en charge sont lentes à dessein (jusqu'à 5 min) : les garde-fous machine voient avec le retard du scrape (voir plus bas) |
| `journeys` | `registered` / `anonymous` : `[{ name, weight, requests }]` |
| `limits` | `maxErrorRate`, `maxP95Ms`, `throttlePerMinute`, `cryptSessionsPerMinute`, `pgConnectionsRatio`, `redisMemoryRatio`, `generatorLoadRatio` |
| `throttle` | `{ moduleId, key, safetyFactor }` — clé de config du limiteur relevée par `throttle raise` (défaut `common` / `common_throttleDefaultLimit` / ×1,5) |
| `monitor` | `sampleSec`, `cooldownSec`, `prometheus { url, userEnv, passwordEnv, queries, jobs, maxScrapeSec }`, `postgres { enabled, envFile, appProcesses, verifySsl }`, `redis { enabled, envFile, maxOpsPerSec }` |
| `cloudflare` | `{ zone, tokenEnv, accountIdEnv? }` |

### Parcours (`journeys`)

`requests` est une liste d'étapes exécutées dans l'ordre ; une étape est un objet, ou un **tableau** d'objets exécutés en
parallèle (`http.batch`, comme le navigateur) :

```json
{ "name": "compass", "weight": 3, "requests": [
  [ { "path": "/papanglabs/compass/composite?lang=en" }, { "path": "/papanglabs/compass/factors?lang=en" } ],
  { "path": "/papanglabs/compass/commentary?lang=en" }
] }
```

Champs d'une étape : `path` (chaîne, ou tableau dont un élément est tiré au hasard), `target` (défaut `api`), `method`
(défaut `GET`), `body`, `headers`, `auth: false` (pas de jeton sur cette étape), `name` (étiquette k6 : à fixer si le
chemin contient des identifiants variables, sinon cardinalité de métriques explosive).

### Requêtes Prometheus (`monitor.prometheus.queries`)

`{ name, query, unit?, guard?: { max } }` — requête **instantanée** exécutée à chaque échantillon ; la série la plus
haute fait foi, son `instance` est rapportée. Avec `guard.max`, franchir le seuil arrête le test. Sans `guard`, la valeur
est seulement reportée.

> **Délai de détection.** Une requête ne voit que ce que Prometheus a scrapé : avec un scrape à 60 s, une fenêtre de `[1m]`
> ne renvoie rien (il faut ≥ 2 scrapes : `[3m]`) et un garde-fou machine réagit avec 1 à 3 minutes de retard.
> `check` mesure l'intervalle réel de chaque job de `monitor.prometheus.jobs` et avertit au-delà de `maxScrapeSec`
> (défaut 20 s). Deux parades : des montées en charge lentes (c'est pourquoi les paliers hauts montent en 4–5 min) et, pour
> un test serré, un intervalle de scrape de 10–15 s sur les jobs gardés pendant le test. Les seuils natifs de k6
> (erreurs, p95) restent immédiats quel que soit le scrape.

## Postgres : `max_connections` est une donnée du plan

Le garde-fou lit `max_connections` en direct (`SHOW max_connections`) et compte **toutes** les connexions de la base, y compris
celles des services internes du fournisseur : il se déclenche à `pgConnectionsRatio` × `max_connections` (70 % par défaut). Si le plan
fige cette valeur, c'est elle qui plafonne les paliers hauts. `check` affiche le pic théorique de l'application
(`DB_POOLSIZE` × `monitor.postgres.appProcesses`) face à ce seuil ; le rapport donne le pic mesuré sous la forme `x / max`.

## Garde-fous

Évalués à chaque échantillon ; le premier franchi stoppe k6 (SIGTERM, SIGKILL après 60 s) et marque le palier `aborted` :

| Source | Condition |
|---|---|
| k6 (seuils natifs) | taux d'erreur > `limits.maxErrorRate` (après 45 s), p95 > `limits.maxP95Ms` (après 60 s) → exit 99 |
| Prometheus | une requête avec `guard.max` dépasse son seuil |
| Postgres | connexions > `pgConnectionsRatio` × `max_connections` (lu en direct, indépendant du plan) |
| Redis | mémoire > `redisMemoryRatio` × `maxmemory` ; débit > `monitor.redis.maxOpsPerSec` si renseigné |
| Générateur | charge 1 min / cœurs > `generatorLoadRatio` (mesure invalide) |
| Baseline | avant le premier palier : si une limite est déjà franchie, `run` refuse de démarrer |

Les quotas d'abonnement (commandes Redis par mois, egress Supabase…) ne sont pas lisibles par API depuis ici : `plan`
estime les opérations Redis par palier (`model.redisOpsPerRequest` : 1 compteur du limiteur de débit + 1 vérification de
révocation de jeton par requête authentifiée), le rapport compare avec la mesure (`total_commands_processed`), et
l'egress des fournisseurs se relève dans leur console avant/après.

## Chiffrement de transport (`model.crypt`)

Le vrai front ouvre une session ECDH (`POST /crypt/session`) puis envoie `x-crypt-session` (et `x-crypt-accept-encoding: deflate`) sur
ses appels API : le back chiffre alors en AES-GCM — après compression — **toute réponse non exemptée** (`@NoTransportCrypt`), séries
d'indicateurs comprises. Sans cet en-tête, k6 recevrait les séries en clair et le travail serveur le plus lourd (ECDH + HKDF à
l'ouverture, deflate + AES-GCM par réponse, **une lecture Redis de la session par requête**) ne serait pas mesuré : c'est
`model.crypt.enabled` (défaut `true`) qui l'ajoute au scénario.

- Chaque VU ouvre **sa** session (renouvelée avant l'expiration, 10 min par défaut) ; les réponses ne sont **pas** déchiffrées,
  seul le coût côté serveur compte. Une session d'un compte de test est ouverte avec son jeton (limite par utilisateur).
- Mesure et limites : la route de session a **sa propre limite** (30/min par identité, `@Throttle` de la route, **non affectée
  par `throttle raise`**). Les VUs enregistrés ont chacun leur identité ; les VUs anonymes d'un seul générateur partagent une IP
  et, au-delà de 30 ouvertures par minute, sont refusés : le VU tourne alors **en clair** et réessaie 30 s plus tard. Le rapport
  donne par palier la part de sessions chiffrées (`Encrypted %`) ; `plan` avertit quand le débit d'ouvertures anonymes dépasse la
  limite. Le trafic anonyme étant léger (pas de séries), l'écart de mesure reste faible ; pour un anonyme 100 % chiffré,
  répartir sur plusieurs IP (`model.generatorIps`).
- Le coût Redis estimé par `plan` intègre la lecture de session (+1 par requête).
- Mettre `model.crypt.enabled` à `false` pour une app qui n'utilise pas le module de chiffrement de `common`.

## Limiteur de débit : ce que le test mesure vraiment

Si le back active `common_throttleEnabled`, l'identité est `user:<id>` pour un jeton, l'IP sinon. Conséquences prises en
compte par `plan` :

- Les comptes de test ont chacun leur seau : réaliste tant que les VUs enregistrés ≤ `userCount` (sinon des VUs partagent un compte,
  avertissement).
- Les anonymes d'un seul générateur partagent **une** IP : au-delà de `limits.throttlePerMinute` par minute, ils prennent des
  429 qui mesurent le limiteur, et tout 429 rend le palier `FAIL`.

`throttle raise [--tier n]...` règle ça sans toucher à l'interface d'admin : il calcule la limite nécessaire (le taux le plus
élevé entre l'IP anonyme et un compte, ×`throttle.safetyFactor`, arrondi à la centaine, jamais sous la limite de production),
lit la valeur actuelle (`GET /admin/module-configs/common`), l'enregistre dans `.loadtest/throttle.json`, puis l'écrit
(`PUT /admin/module-configs/common`). La limite est lue à chaque requête par le back : aucun redémarrage. `run` **refuse de
démarrer** tant que le limiteur n'est pas assez relevé pour les paliers demandés ; `throttle restore` (ou `teardown`) remet la valeur
d'origine, même après un plantage (la valeur d'origine est conservée si on relève deux fois). Tant que le limiteur est relevé,
`run` et `check` le rappellent.

## Cloudflare (exception temporaire)

Derrière Cloudflare, un test depuis une IP déclenche règles WAF / rate limiting / bot et mesure Cloudflare, pas l'origine.
`cloudflare allow` ajoute en **première** règle personnalisée une règle `skip` (WAF, rate limiting, sécurité) pour les
requêtes portant l'en-tête `x-loadtest-key` = secret aléatoire (stocké dans `.loadtest/cloudflare.json`, ajouté
automatiquement par `run`). `cloudflare revoke` la supprime. **À retirer dès la fin du test.**

- `cloudflare check` (lecture seule) vérifie le token, la visibilité de la zone, la lecture des règles et, d'après les politiques du token, l'accès en écriture au WAF ; il ne crée rien. Un token qui ne voit pas la zone est refusé.
- `cloudflare plan` imprime la règle JSON exacte à poser à la main si le token n'a pas la permission.
- Le *Bot Fight Mode* du plan gratuit n'est contournable par aucune règle.
- L'écriture dans l'API Cloudflare n'est exécutée que par `allow`/`revoke`, jamais par `run`.

## Nettoyage

- `teardown` : révoque chaque `jti` puis `DELETE /users/admin/:id` (soft delete + anonymisation : les lignes restent).
- `teardown --hard` : suppression SQL pour ne rien laisser. Les tables liées sont **découvertes par clés étrangères** de
  `auth.userTable`, la suppression est faite dans **une seule transaction**, **annulée par défaut** (dry run, affiche le nombre de lignes par table) ;
  `--apply` valide. Refuse de tourner si un id n'est pas un compte `<prefix>-*`. Un échec de clé étrangère annule tout. Postgres uniquement.
  À lancer **après** `teardown` (les jetons sont déjà révoqués).

## Artefacts (`.loadtest/`, ignoré par git)

```
.loadtest/secrets.env  users.json  cloudflare.json
.loadtest/runs/<runId>/report.md
.loadtest/runs/<runId>/<tier>/{plan.json, k6config.json, samples.jsonl, summary.json, meta.json}
```

`k6config.json` ne contient aucun secret. `users.json` contient les jetons des comptes de test : droits 600.

## Rapport

Par palier : sessions, requêtes, req/s, p50/p95/p99, % d'erreurs, 429, 5xx, verdict (`OK` / `FAIL — raisons`) ; pics de
ressources (valeur et instance la plus chargée) ; p95 par page ; commandes Redis mesurées vs estimées ; requêtes SQL les plus
coûteuses pendant le palier (`pg_stat_statements`, si disponible) ; **extrapolation** linéaire du nombre de sessions auquel la
latence et chaque métrique gardée atteindraient leur limite (indicative, ≥ 3 paliers, sans effet de seuil ni de cache).

## Limites connues

- Le flux de login (code e-mail, wallet) n'est pas chargé : les sessions utilisent des jetons statiques.
- Les appels directs navigateur → services annexes (ex. une API de métriques appelée depuis le front) ne sont chargés que
  si une étape les cible explicitement (`target`).
- Les requêtes Prometheus sont instantanées : la précision est celle de l'intervalle de scrape.
- Les règles WAF Cloudflare (`cloudflare allow`) suivent le format documenté de l'API mais ne sont validées que par
  exécution réelle : si l'API refuse, rien n'est créé et l'erreur est affichée.

## Tests

```bash
node --test scripts/loadtest/lib/*.test.mjs scripts/loadtest/k6/*.test.mjs scripts/loadtest/loadtest.e2e.test.mjs
```

Aucune cible distante n'est contactée. `loadtest.e2e.test.mjs` fait tourner le vrai CLI avec le vrai k6 contre un serveur local
factice (jusqu'au rapport) ; il est sauté si k6 n'est pas installé.

## Fichiers

| Fichier | Rôle |
|---|---|
| `PROCEDURE.md` | Procédure de lancement d'un test, dans l'ordre, avec le désarmement de tout ce qui a été armé |
| `loadtest.mjs` | CLI |
| `k6/scenario.js` | Scénario k6 piloté par la config d'exécution générée |
| `lib/config.mjs` | Défauts, fusion, validation |
| `lib/profile.mjs` | Modèle de charge : sessions → VUs → stages, estimation du trafic |
| `lib/guards.mjs` | Garde-fous |
| `lib/prometheus.mjs`, `lib/samplers.mjs` | Échantillonnage Prometheus, Postgres, Redis, générateur |
| `lib/runner.mjs` | Exécution d'un palier (k6 + échantillons + garde-fous) |
| `lib/adminApi.mjs` | Création / suppression des comptes de test |
| `lib/hardDelete.mjs` | Suppression SQL optionnelle (transaction, dry run) |
| `lib/cloudflare.mjs` | Exception WAF temporaire |
| `lib/probe.mjs` | Validation des parcours |
| `lib/throttle.mjs` | Relèvement / restauration temporaires du limiteur de débit |
| `lib/tiers.mjs` | Choix du tier des comptes de test (`GET /tiers/public`) |
| `lib/report.mjs` | Digest k6, pics, verdict, extrapolation, Markdown |
| `loadtest.config.example.json`, `secrets.env.example` | Modèles copiés par `init` |
