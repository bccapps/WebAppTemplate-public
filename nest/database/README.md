# Module Database

## Rôle

Socle multi-base de données partagé entre tous les projets VXFramework (React/Nest).
Fournit une construction d'options TypeORM **pilotée par l'environnement** et permet
d'assigner certains modules à une base de données dédiée, sans modifier leur code.

- **Connexion `main`** — la connexion par défaut (NestJS *default*, sans nom). Tous les
  `@InjectRepository(Entity)` existants la visent : comportement legacy strictement préservé.
- **Connexions nommées** — bases additionnelles déclarées par env, vers lesquelles on route
  des modules ciblés (isolation / perf).
- **Dormant par défaut** : tant qu'aucune connexion ni routage n'est déclaré, une seule
  connexion `main` est construite, identique à l'ancien `Datasource.ts` mono-connexion.

Module quasi autonome : ne dépend que de `typeorm`, `@nestjs/typeorm` et du module `common` (toujours lié, il porte
les utilitaires de moteur), pour fonctionner dans n'importe quel projet quel que soit son lot de modules.

## Architecture

| Type | Fichier | Description |
|------|---------|-------------|
| Module | `DatabaseModule.ts` | `forRoot({ context, mainDataSource })` : enregistre la connexion `main` + les connexions nommées |
| Helper | `databases.ts` | `buildMainDataSourceOptions`, `buildExtraDataSourceOptions`, `resolveEntityGlobs`, type `DbContext` |
| Helper | `dbEngine.ts` | Ré-exporte depuis `common/utils/dbEngine.ts` (où ils vivent, pour que `common` et `voice` n'importent jamais `database`, absent chez certains projets) : `isSqlite`, `isSqliteDataSource`, `resolveEngine`, types de colonnes portables `jsonColumnType`, `timestampColumnType`, et `portableQuery` (SQL brut `$n` → `?` sous SQLite) |
| Helper | `dbRouting.ts` | `dbFor`, `connectionToken`, `parseModuleRouting`, `parseConnectionNames`, `isRoutingActive`, `MAIN_CONNECTION` (défini dans `common/utils/dbEngine.ts`, ré-exporté) |
| Helper | `schemaMode.ts` | `resolveSchemaMode` (fonction pure : `synchronize` / `migrationsRun` / migrations chargées), `detectTypeormCli`, `logSchemaMode` — voir « Gestion du schéma » |
| Helper | `schemaGuard.ts` | `evaluateSchemaGuard` (pur), `inspectSchemaState`, `runSchemaGuard` : garde-fous au démarrage |
| Helper | `sqliteBackup.ts` | `backupSqliteIfVersionChanged`, `resolveAppVersion`, `pruneBackups` : copie du fichier SQLite avant mise à jour du schéma |
| Helper | `schemaPreflight.ts` | `prepareSchema` : garde-fous + sauvegarde, appelé par `DatabaseModule` avant `initialize()` |
| Barrel | `index.ts` | Ré-exporte tout le module |

Pas d'entités, de contrôleurs ni d'endpoints HTTP (module d'infrastructure pur).

## Dépendances

- `typeorm` (`DataSource`, `DataSourceOptions`)
- `@nestjs/typeorm` (`TypeOrmModule.forRootAsync`)
- `@nestjs/common` (`DynamicModule`)

## Intégration projet

Le projet reste responsable des **chemins** (résolus depuis son propre `__dirname`) ; le module
ne déduit jamais ses chemins de sa propre localisation (il est symlinké/compilé dans chaque app).

`back/src/config/Datasource.ts` (symlink du template, ou fichier local mince si le projet le surcharge) :

```ts
import { join } from 'path';
import { DataSource } from 'typeorm';
import { buildMainDataSourceOptions, DbContext } from 'src/modules_shared/database';

// Le template est symlinké : sous ts-node `__dirname` est le chemin RÉEL (dans .libs/), pas back/src/config.
const isTypeScriptRun = __filename.endsWith('.ts');
const backDir = isTypeScriptRun ? process.cwd() : join(__dirname, '..', '..');   // back/
const baseDir = isTypeScriptRun ? join(backDir, 'src') : join(__dirname, '..');  // src/ ou dist/

export const dbContext: DbContext = {
  baseDir,
  certBaseDir: backDir,                                  // pour DB_SSLROOTCERT
  migrationGlobs: [join(baseDir, 'migrations/*.{js,ts}')],
};

// Connexion "main" — aussi utilisée par le CLI TypeORM / migrations.
const AppDataSource = new DataSource(buildMainDataSourceOptions(dbContext));
export default AppDataSource;
```

Un `Datasource.ts` **réel** (override projet, non symlinké) peut continuer à utiliser `join(__dirname, '..')`.
Le CLI TypeORM / ts-node doit être lancé depuis `back/` avec `-r tsconfig-paths/register` (alias `src/`).

`AppModule` :

```ts
import AppDataSource, { dbContext } from '../../config/Datasource';
import { DatabaseModule } from '../../modules_shared/database';

imports: [
  DatabaseModule.forRoot({ context: dbContext, mainDataSource: AppDataSource }),
  // ...
]
```

## Contrat d'environnement

| Variable | Connexion | Description |
|----------|-----------|-------------|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | main | Connexion par défaut (inchangé) |
| `DB_SSLMODE` / `DB_SSLROOTCERT` / `DB_POOLSIZE` | main | SSL + pool |
| `DB_ENGINE` (`postgres`/`cloud`/`neon`/`supabase`/`sqlite`) | main (`DB__<NAME>__ENGINE` pour une nommée) | Moteur (défaut `postgres`) |
| `DB_SCHEMA_MODE` (`sync` / `migrations` / `manual`) | main (`DB__<NAME>__SCHEMA_MODE` pour une nommée) | **Gestion du schéma** (voir « Schema management » ci-dessous) ; vide = défauts ci-dessous. `DB_SYNC` / `TYPEORM_SYNC` n'existent plus : les poser arrête le démarrage |
| `DB_PATH` | main | SQLite : fichier de base (absolu, `:memory:`, ou relatif à `APP_DATA_DIR` si défini, sinon au dossier `back/`) |
| `DB_MIGRATIONS_RUN=true` | main | ANCIEN alias : exécute les migrations au démarrage (tous moteurs ; usage typique : app de bureau) |
| `DB_BACKUP_REQUIRED=true` | sqlite | Une sauvegarde échouée avant mise à jour du schéma bloque le démarrage (sinon : journalisée) |
| `APP_VERSION` | sqlite | Version de l'appli pour la sauvegarde (défaut : `version` du `package.json` du dossier `back/`) |
| `DB_CONNECTIONS=analytics,archive` | — | Liste des connexions nommées additionnelles |
| `DB__<NAME>__HOST` / `__PORT` / `__USER` / `__PASSWORD` / `__NAME` | nommée | Idem `DB_*` mais pour la connexion `<NAME>` |
| `DB__<NAME>__SSLMODE` / `__SSLROOTCERT` / `__POOLSIZE` / `__ENGINE` / `__SCHEMA_MODE` / `__PATH` | nommée | Options de la connexion `<NAME>` |
| `DB_MODULE_ROUTING={"token-trader":"analytics"}` | — | Route un `moduleId` vers une connexion |

## Moteurs

| Moteur | Pilote TypeORM | Variables utilisées |
|--------|----------------|---------------------|
| `postgres` (défaut), `cloud`, `neon`, `supabase` | `postgres` | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, SSL, pool |
| `sqlite` | `better-sqlite3` | `DB_PATH` uniquement (SSL, pool, hôte ignorés) |

SQLite : le dossier parent du fichier est créé s'il manque, le mode WAL et `foreign_keys = ON` sont activés
au démarrage. Une seule instance applicative doit écrire dans la base. `better-sqlite3` est une dépendance
native **non incluse** dans `package.base.json` : l'ajouter au `package.local.json` du projet qui choisit SQLite
(`databases.ts` ne l'importe jamais, TypeORM le charge). Exemple `.env` :

```
DB_ENGINE=sqlite
DB_PATH=data/app.db
DB_MIGRATIONS_RUN=true
```

### Types de colonnes portables

Pour qu'une entité fonctionne sur les deux moteurs : `@Column({ type: jsonColumnType() })` (`jsonb` ou
`simple-json`) et `@Column({ type: timestampColumnType() })` (`timestamptz` ou `datetime`). `isSqlite(connection = 'main')`
indique le moteur d'une connexion. **Contrainte** : le moteur est fixé au démarrage du processus, car les
décorateurs sont évalués à l'import ; l'environnement (`.env`) doit donc être chargé avant l'import des entités.

Entités publiques déjà portées (noms de colonnes et types Postgres inchangés, donc aucune migration Postgres) :
`common` (`EventFeedEntityBase`, `CookieConsentEntity`, `ThemeEntity`) et `voice` (`VoiceAccessEntity`,
`UserVoiceAccessEntity`, `VoiceProviderCatalogEntity`). Les entités de vx-private restent Postgres.

### SQL brut portable

Un `dataSource.query()` n'est pas traduit par TypeORM : sous SQLite, `$1` n'est pas accepté (le pilote veut `?`),
et `NOW()`, `TO_TIMESTAMP`, `ANY($1)`, `EXTRACT(EPOCH …)` n'existent pas. Préférer le QueryBuilder ; à défaut,
`portableQuery(isSqliteDataSource(dataSource), sql, params)` convertit les placeholders, et les dates se
passent en paramètres ISO-8601 plutôt qu'avec `NOW()`. `CronLockService` en est l'exemple (verrou en mémoire
du processus sous SQLite : une seule instance par base). `common/utils/CrossEnvDbConnection.ts` (pool `pg`
direct) reste Postgres uniquement.

Test d'intégration SQLite en mémoire : `common/sqlite.integration.spec.ts` (nécessite `better-sqlite3`, non
inclus dans `package.base.json`).

### Portabilité automatique Postgres → SQLite

Choisir SQLite (`DB_ENGINE=sqlite`) ne demande plus de réécrire les entités : `buildMainDataSourceOptions()` appelle
`applyPortableColumnTypes('sqlite')` (`common/utils/portableTypes.ts`, ré-exporté ici) avant que TypeORM ne valide les métadonnées.
Sous Postgres rien n'est appelé : le comportement est identique.

| Automatique (SQLite) | Résultat |
|---|---|
| `jsonb` / `json` / `hstore`, `array: true` | `simple-json` (texte JSON) |
| `timestamptz`, `timestamp [with/without time zone]`, `timetz` | `datetime` / `time` (`precision` retiré) |
| `enum` | `simple-enum` ; `bytea` → `blob` ; `int2/int4/int8/float4/float8/bool` → types SQLite ; `citext/inet/cidr/…` → `varchar` |
| défauts `() => 'now()'`, `gen_random_uuid()`, `'[]'::jsonb`, `'{}'` (tableau) | `CURRENT_TIMESTAMP`, expression UUID v4, `'[]'` |
| index `concurrent/spatial/fulltext…`, `where` avec casts | retirés / casts supprimés ; un index **unique** partiel inexprimable est supprimé (sinon il sur-contraindrait) |
| `@Check` avec casts, `@Entity({ schema })`, `generated: 'identity'` | casts supprimés / schéma ignoré / `increment` |

Les décorateurs évalués **après** l'appel (TypeORM importe les entités ensuite) sont adaptés à l'enregistrement. Si une autre connexion
tourne sous Postgres, l'adaptation automatique est **désactivée** (les métadonnées sont globales au processus) : utiliser alors
`jsonColumnType()`/`timestampColumnType()` dans les entités de la connexion SQLite. `DB_PORTABLE_LOG=false` supprime la ligne de bilan.

**Pas traduit automatiquement** (voir `common/utils/dbDialect.ts` et l'opérateur TypeORM `ILike()`) : `ILIKE`, `::cast`, `@>`, `->>`,
`to_char`, `date_trunc`, `RETURNING`, `NOW()`, `ANY()`, `FOR UPDATE`/`setLock`, `generate_series`, `DISTINCT ON`, les advisory locks.
`dialect()` / `dialectOf(dataSource)` fournissent `ilike`, `monthBucket`, `dayBucket`, `now`, `epochSeconds`, `castText`,
`jsonExtract(col, 'a.b')`, `jsonArrayContains(col, ':param')`, `forUpdate`, `lockForWrite(qb)`. Côté lecture : `parseDbDate` (un
`MAX(date)` brut revient **sans fuseau** sous SQLite), `toNumber` (agrégats : chaînes sous Postgres, nombres sous SQLite),
`isUniqueViolation` / `isForeignKeyViolation` / `isNotNullViolation` (codes Postgres et SQLite).

Différences de sémantique à connaître : le JSON est du texte (aucune requête/indice à l'intérieur de la colonne), les dates n'ont pas de
fuseau (UTC par convention), un entier au-delà de 2^53 perd de la précision, **un seul écrivain** (verrou d'écriture unique,
`busy_timeout` = `DB_BUSY_TIMEOUT_MS`, 5000 ms par défaut), pas de verrous de ligne, `ALTER` = recréation de table (garder les
changements d'entités **additifs** entre deux versions, sauvegarder le fichier avant une mise à jour).

**Défauts SQLite** : sans migrations propres, le schéma vient de `synchronize` (**activé par défaut, même en production** ; `DB_SCHEMA_MODE=manual`
l'emporte) et les migrations (écrites en SQL Postgres) ne sont **pas chargées**. Une appli qui livre ses **propres migrations SQLite**
(`DB_MIGRATIONS_RUN=true` ou `DB_SQLITE_MIGRATIONS=true`) garde le comportement historique : migrations chargées, `synchronize` résolu
comme sous Postgres (défaut désactivé en production). Pragmas : WAL, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout`.

**Garde-fou** — `npm run db:check` (`scripts/db-portability-check.mjs`, sans base) : (1) scan statique de `src/**` (hors tests, migrations
et modules partagés liés) pour le SQL propre à Postgres, exemptable ligne par ligne par `// pg-only: <raison>` ; (2) base SQLite en
mémoire construite depuis les entités de l'appli (modules dont `module.json` n'a pas `sqlite` dans `databases` ignorés) puis
synchronisée — **seulement si le projet tourne sur SQLite** (`DB_ENGINE=sqlite` dans l'environnement ou un `.env*` du back, ou shell
desktop `desktop/desktop.config.json`) : un projet Postgres saute cette étape et n'a pas besoin de `better-sqlite3` ; `--schema-only` la
force. Options : `--json`, `--static-only`, `--schema-only`, `--include-postgres-only`, `--include-shared`. Code de sortie 0 / 1 / 2.
Gabarit de suite Jest SQLite : `template/back/sqlite-harness/`.

### Taille du pool (`DB_POOLSIZE`)

`DB_POOLSIZE` fixe le nombre max de connexions **par instance applicative**. Sur un moteur
cloud (`cloud`/`neon`/`supabase`) la valeur par défaut est `10`.

Attention avec un pooler : Supabase en **mode session** (port `5432`) limite le nombre
**total** de clients au `pool_size` du projet (15 par défaut). Ce budget est partagé par
toutes les instances — répliques `api` **et** worker. Si
`(BACK_REPLICAS + 1) * DB_POOLSIZE` dépasse la limite, les instances démarrées en dernier
crashent au boot avec `EMAXCONNSESSION: max clients reached in session mode`. Le mode
**transaction** (port `6543`) n'a pas cette contrainte.

> TypeORM fusionne `extra` **par-dessus** son propre `{ max: poolSize }`
> (`PostgresDriver.createPool`) : `extra.max` est donc aligné sur `DB_POOLSIZE` par
> `buildDataSourceOptions`, sans quoi la valeur cloud écraserait silencieusement l'env var.

**Piège fréquent : un dev local pointé sur le même projet Supabase qu'un environnement
déployé** (ex. pour ne jamais risquer de toucher aux vraies données de prod depuis le poste
du développeur) partage le même budget de `pool_size`, même quand il n'est pas sollicité —
NestJS ouvre des connexions dès le boot (seeders `OnApplicationBootstrap`, etc.), pas
seulement à la première requête. Un `./scripts/run.sh` local oublié en tâche de fond peut
donc à lui seul faire déborder le budget d'un environnement déployé qui, vu de l'extérieur,
semble à peine sollicité. Garder `DB_POOLSIZE` bas côté dev (2-3 : un seul développeur) pour
laisser la marge à l'environnement qui sert du vrai trafic. Le boot log `[DB] "<name>" pool:
max=...` (émis pour tout moteur cloud) permet de vérifier la valeur effective sans requêter
`pg_stat_activity`.

## Gestion du schéma (Schema management)

Une seule règle, déterministe, pour tous les projets et les deux moteurs : `resolveSchemaMode` (`schemaMode.ts`, fonction pure) décide de
`synchronize`, `migrationsRun` et du chargement des migrations, et le journalise une fois au démarrage :
`[DB] schema mode: <mode> (<raison>)`.

| `DB_SCHEMA_MODE` | `synchronize` | migrations | Usage |
|---|---|---|---|
| `sync` | oui | non chargées | dev ; SQLite dont les migrations sont du SQL Postgres (ex. variante bureau d'AgentHub) ; prod Postgres pilotée par `synchronize` (warning : un changement destructif d'entité **supprime** des données) |
| `migrations` | non | chargées **et jouées au démarrage** | SQLite avec migrations propres (bureau) ; prod Postgres où les migrations sont la seule source du schéma |
| `manual` | non | chargées, **non jouées** | prod Postgres classique : migrations appliquées à la main (`typeorm migration:run`, `run.sh --migrate`) |

Un `DB_SCHEMA_MODE` invalide arrête le démarrage en nommant les valeurs acceptées. `sync` et `migrationsRun` ne sont **jamais** combinés par ce réglage.

**Ordre de résolution** — (1) le **CLI typeorm** (détecté : `typeorm`/`typeorm-ts-node-*` dans `argv`, ou `TYPEORM_CLI=1`, ou
`buildMainDataSourceOptions(ctx, { cli: true })`) charge **toujours** les migrations et ne synchronise **ni** ne joue jamais rien
automatiquement, quel que soit l'environnement ; (2) `DB_SCHEMA_MODE` ; (3) les **anciens réglages**, résolus exactement comme avant
(la table est figée dans `schemaMode.legacy.fixture.json`, test `schemaMode.characterization.spec.ts` ; `DB_SYNC` et `TYPEORM_SYNC`, retirés, **arrêtent le démarrage** en nommant `DB_SCHEMA_MODE=sync` comme remplaçant) :

| Moteur | Anciens réglages (sans `DB_SCHEMA_MODE`) |
|---|---|
| Postgres | `synchronize` (défaut : `NODE_ENV !== 'production'`), `DB_MIGRATIONS_RUN` → `migrationsRun`, **indépendants**, migrations toujours chargées |
| SQLite | `DB_MIGRATIONS_RUN` ou `DB_SQLITE_MIGRATIONS` vrai → migrations propres (chargées, `synchronize` comme Postgres) ; sinon `synchronize` (défaut **oui**) et migrations non chargées |

**Garde-fous au démarrage** (`schemaGuard.ts`, appelés par `DatabaseModule` avant que TypeORM n'applique le schéma, via une connexion
de sonde sans entités) : `DB_SCHEMA_MODE=migrations` sur une base qui a des tables **sans** table `migrations` (construite par
`synchronize`) → **arrêt** avec les trois issues (passer en `sync`, repartir d'une base vide, ou « baseline »), au lieu de « table
already exists » ; `synchronize` sur une base dont la table `migrations` liste des migrations appliquées → avertissement « MIXED SCHEMA
MANAGEMENT ». Avec les anciens réglages (`DB_MIGRATIONS_RUN` seul) ce n'est qu'un avertissement : des migrations idempotentes marchaient
sur une base construite par `synchronize`.

**Sauvegarde SQLite** (`sqliteBackup.ts`) : `synchronize` recrée une table quand une colonne d'entité change, et une colonne
supprimée ou retypée par une nouvelle version perd ses données. Avant d'appliquer le schéma à un fichier **existant** dont la
version de l'appli a changé depuis le dernier démarrage (`<db>.version`), une copie cohérente (API de sauvegarde en ligne de
`better-sqlite3`) est faite : `<db>.bak-<ancienneVersion>-<horodatage>`, les 3 dernières sont conservées. Jamais pour `:memory:` ;
un échec est journalisé sans bloquer (sauf `DB_BACKUP_REQUIRED=true`). Version : `APP_VERSION`, sinon `version` du `package.json`
de `back/`. Le CLI typeorm ne sauvegarde pas.

**Scénarios**

| Scénario | Réglage |
|---|---|
| Dev (Postgres ou SQLite) | rien : `synchronize` actif hors production (SQLite : toujours) |
| Prod Postgres, migrations manuelles | `DB_SCHEMA_MODE=manual` puis `typeorm migration:run` / `run.sh prod --migrate` |
| Prod Postgres, migrations jouées au démarrage | `DB_SCHEMA_MODE=migrations` |
| Prod Postgres pilotée par `synchronize` (AgentHub) | `DB_SCHEMA_MODE=sync` (équivalent de l'ancien `TYPEORM_SYNC=true`) ; les migrations restent applicables à la main par le CLI |
| Bureau SQLite, schéma par `synchronize` | `"schema": "sync"` dans `desktop.config.json` (la coquille force `DB_SCHEMA_MODE=sync`) |
| Bureau SQLite, migrations propres | `"schema": "migrations"` (absent = ancien comportement : la coquille force `DB_MIGRATIONS_RUN=true`) |

## Câbler un module vers une connexion nommée

`dbFor(moduleId)` renvoie la connexion logique ; `connectionToken(...)` la convertit en token
d'injection NestJS (`undefined` pour `main`). À utiliser aux deux points de câblage :

```ts
const DB = connectionToken(dbFor('token-trader'));     // -> 'analytics' ou undefined
TypeOrmModule.forFeature([TokenEntity], DB)
@InjectRepository(TokenEntity, DB) repo
```

## Points d'extension

- Nouveau moteur SQL : une fonction `build<Moteur>Options` dans `databases.ts` + le dispatch de `buildConnectionOptions`.
- Nouveau moteur cloud → étendre la liste `isCloud` dans `databases.ts`.
- Partition d'entités personnalisée → `resolveEntityGlobs`.

## Contraintes (toute connexion routée)

- ❌ Pas de jointure / clé étrangère / relation `@ManyToOne` **cross-DB**.
- ❌ Pas de transaction **cross-DB**.
- `synchronize` et migrations sont gérés **par connexion** (migrations sur `main` uniquement).
