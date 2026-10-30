# Test de charge (`scripts/loadtest`)

Outil générique de test de charge d'un environnement **déjà déployé** : simule des sessions simultanées (utilisateurs
enregistrés + visiteurs anonymes) par paliers, mesure en parallèle la santé des machines, de Postgres et de Redis, coupe
le test tout seul quand une limite est franchie, puis produit un rapport Markdown avec une extrapolation du point de
saturation. Disponible dans tous les projets (le dossier `scripts/` est lié depuis le template) ; **rien à câbler** :
ce n'est ni un module `nest/` ni un module `react/`.

Le moteur est générique. Tout ce qui est propre à un projet (URL, parcours, requêtes Prometheus, paliers) vit dans
`loadtest.config.json` à la racine du projet.

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
- Pour plus de ~300 sessions : exécuter le CLI **depuis une VM jetable** proche de la cible (pas depuis un portable). Le
  générateur surveille sa propre charge (`limits.generatorLoadRatio`) et arrête le test s'il sature : des résultats
  mesurés sur un générateur saturé ne valent rien.

## Démarrage rapide

```bash
node scripts/loadtest/loadtest.mjs init            # crée loadtest.config.json, .loadtest/secrets.env, .gitignore
$EDITOR .loadtest/secrets.env loadtest.config.json # secrets puis cibles / parcours
node scripts/loadtest/loadtest.mjs plan            # trafic estimé, opérations Redis, avertissements — rien n'est contacté
node scripts/loadtest/loadtest.mjs check           # lecture seule : k6, cibles, token, Prometheus/Postgres/Redis, baseline
node scripts/loadtest/loadtest.mjs setup           # crée les comptes de test + jetons (.loadtest/users.json, mode 600)
node scripts/loadtest/loadtest.mjs probe           # 1 GET par étape de parcours : valide les chemins avant la charge
node scripts/loadtest/loadtest.mjs run --tier smoke --confirm api.example.com
node scripts/loadtest/loadtest.mjs run --tier u50 --tier u200 --confirm api.example.com
node scripts/loadtest/loadtest.mjs teardown        # révoque les jetons, supprime les comptes
```

### Où mettre les secrets

Dans **`.loadtest/secrets.env`** (créé par `init`, droits 600, ignoré par git) ou exportés dans le terminal. Jamais dans
`loadtest.config.json` (versionné), jamais dans une conversation.

| Variable | Rôle |
|---|---|
| `LOADTEST_ADMIN_TOKEN` | Token admin de l'API cible (`auth.adminTokenEnv`) : création/suppression des comptes. Jamais transmis à k6 |
| `LOADTEST_PROM_USER` / `LOADTEST_PROM_PASSWORD` | Basic auth du Prometheus interrogé |
| `LOADTEST_PG_URL` | Connexion Postgres de supervision (sinon assemblée depuis les `DB_*` de `monitor.postgres.envFile`) |
| `LOADTEST_REDIS_URL` | Connexion Redis de supervision (sinon `REDIS_URL` de `monitor.redis.envFile`) |
| `CLOUDFLARE_API_TOKEN` | Token API Cloudflare (Zone → Zone WAF → Edit) pour `cloudflare allow\|revoke` |

## Commandes

| Commande | Contacte la cible ? | Rôle |
|---|---|---|
| `init` | non | Crée config, dossier `.loadtest/` (700), `secrets.env`, entrée `.gitignore` |
| `plan [--tier n]` | non | Sessions, VUs, req/s, opérations Redis estimées par palier + avertissements |
| `check` | lecture seule | k6, `GET <api>/health`, présence du token, connexion des échantillonneurs, baseline sous les garde-fous |
| `setup [--count N]` | **écrit** | Crée les comptes `<prefix>-NNN` et leurs jetons ; reprenable (journal écrit après chaque compte) |
| `probe` | lecture | Une requête GET par étape de chaque parcours (POST ignorés), tableau de statuts |
| `run --tier <n>... --confirm <hôte>` | **charge** | Exécute les paliers listés, dans l'ordre, avec `monitor.cooldownSec` entre eux ; écrit le rapport |
| `report <runId>` | non | Régénère `report.md` d'un run (`.loadtest/runs/<runId>/`) |
| `teardown [--hard [--apply]]` | **écrit** | Révoque les `jti`, supprime les comptes via l'API admin. `--hard` : suppression SQL (voir plus bas) |
| `cloudflare plan\|allow\|revoke` | `allow`/`revoke` écrivent | Exception WAF temporaire (voir plus bas) |

Options communes : `--root <dir>`, `--config <fichier>`.

## `loadtest.config.json`

Fusionné avec les défauts de `lib/config.mjs` (un objet se fusionne clé par clé, un tableau remplace). Exemple minimal :
`loadtest.config.example.json`.

| Clé | Rôle |
|---|---|
| `targets` | `api` (obligatoire, **base incluant `/api/v1`**), `front`, et toute autre cible nommée utilisable par `step.target` |
| `headers` | En-têtes ajoutés : `all` et/ou par cible. Ne pas envoyer l'en-tête de transport chiffré/compressé si le back le négocie (`x-crypt-accept-encoding`) : la réponse reste en clair |
| `auth` | `userCount`, `prefix`, `tierId` (tier donnant accès aux pages testées), `userTable`/`nicknameColumn` (suppression SQL), `adminTokenEnv`, `paths` des routes admin |
| `model` | `mix` (somme = 1), `thinkSec` `[min, max]`, `avgPageSec`, `coldLoadRatio` `{ registered, anonymous }` (part des sessions qui téléchargent index + assets du front), `redisOpsPerRequest`, `generatorIps` |
| `tiers` | `[{ name, concurrent, rampSec, holdSec, optional? }]` — défauts : `smoke` 5, `u50`, `u200`, `u500`, `u1000` (optionnel) |
| `journeys` | `registered` / `anonymous` : `[{ name, weight, requests }]` |
| `limits` | `maxErrorRate`, `maxP95Ms`, `throttlePerMinute`, `pgConnectionsRatio`, `redisMemoryRatio`, `generatorLoadRatio` |
| `monitor` | `sampleSec`, `cooldownSec`, `prometheus { url, userEnv, passwordEnv, queries }`, `postgres`, `redis` |
| `cloudflare` | `{ zone, tokenEnv }` |

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

> **Délai de détection.** Une requête ne voit que ce que Prometheus a scrapé : si un `node_exporter` est scrapé toutes les
> 60 s, utiliser `rate(...[3m])` (une fenêtre de `[1m]` ne renvoie rien) et accepter un garde-fou machine qui réagit avec
> 1 à 3 minutes de retard. Pour un test serré, descendre temporairement l'intervalle de scrape à 10–15 s.

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

## Limiteur de débit : ce que le test mesure vraiment

Si le back active `common_throttleEnabled`, l'identité est `user:<id>` pour un jeton, l'IP sinon. Conséquences prises en
compte par `plan` :

- Les comptes de test ont chacun leur seau : réaliste tant que les VUs enregistrés ≤ `userCount` (sinon des VUs partagent un compte,
  avertissement).
- Les anonymes d'un seul générateur partagent **une** IP : au-delà de `limits.throttlePerMinute` par minute, ils prennent des
  429 qui mesurent le limiteur. Relever temporairement `common_throttleDefaultLimit` (admin, sans redémarrage) pendant les paliers
  concernés, ou répartir sur plusieurs générateurs (`model.generatorIps`). Tout 429 rend le palier `FAIL` dans le rapport.

## Cloudflare (exception temporaire)

Derrière Cloudflare, un test depuis une IP déclenche règles WAF / rate limiting / bot et mesure Cloudflare, pas l'origine.
`cloudflare allow` ajoute en **première** règle personnalisée une règle `skip` (WAF, rate limiting, sécurité) pour les
requêtes portant l'en-tête `x-loadtest-key` = secret aléatoire (stocké dans `.loadtest/cloudflare.json`, ajouté
automatiquement par `run`). `cloudflare revoke` la supprime. **À retirer dès la fin du test.**

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
node --test scripts/loadtest/lib/*.test.mjs scripts/loadtest/k6/*.test.mjs   # aucune cible contactée, k6 non requis
```

## Fichiers

| Fichier | Rôle |
|---|---|
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
| `lib/report.mjs` | Digest k6, pics, verdict, extrapolation, Markdown |
| `loadtest.config.example.json`, `secrets.env.example` | Modèles copiés par `init` |
