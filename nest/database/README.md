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

Module **autonome** : ne dépend que de `typeorm` et `@nestjs/typeorm` (aucun autre module
nestcommon), pour fonctionner dans n'importe quel projet quel que soit son lot de modules.

## Architecture

| Type | Fichier | Description |
|------|---------|-------------|
| Module | `DatabaseModule.ts` | `forRoot({ context, mainDataSource })` : enregistre la connexion `main` + les connexions nommées |
| Helper | `databases.ts` | `buildMainDataSourceOptions`, `buildExtraDataSourceOptions`, `resolveEntityGlobs`, type `DbContext` |
| Helper | `dbRouting.ts` | `dbFor`, `connectionToken`, `parseModuleRouting`, `parseConnectionNames`, `isRoutingActive`, `MAIN_CONNECTION` |
| Barrel | `index.ts` | Ré-exporte tout le module |

Pas d'entités, de contrôleurs ni d'endpoints HTTP (module d'infrastructure pur).

## Dépendances

- `typeorm` (`DataSource`, `DataSourceOptions`)
- `@nestjs/typeorm` (`TypeOrmModule.forRootAsync`)
- `@nestjs/common` (`DynamicModule`)

## Intégration projet

Le projet reste responsable des **chemins** (résolus depuis son propre `__dirname`) ; le module
ne déduit jamais ses chemins de sa propre localisation (il est symlinké/compilé dans chaque app).

`back/src/config/Datasource.ts` (fichier local mince) :

```ts
import { join } from 'path';
import { DataSource } from 'typeorm';
import { buildMainDataSourceOptions, DbContext } from '../modules_shared/database';

export const dbContext: DbContext = {
  baseDir: join(__dirname, '..'),                       // src/
  certBaseDir: join(__dirname, '..', '..'),             // back/  (pour DB_SSLROOTCERT)
  migrationGlobs: [join(__dirname, '../migrations/*.{js,ts}')],
};

// Connexion "main" — aussi utilisée par le CLI TypeORM / migrations.
const AppDataSource = new DataSource(buildMainDataSourceOptions(dbContext));
export default AppDataSource;
```

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
| `DATABASE_ENGINE` (`postgres`/`cloud`/`neon`/`supabase`) / `TYPEORM_SYNC` | main | Moteur + synchronize |
| `DB_CONNECTIONS=analytics,archive` | — | Liste des connexions nommées additionnelles |
| `DB__<NAME>__HOST` / `__PORT` / `__USER` / `__PASSWORD` / `__NAME` | nommée | Idem `DB_*` mais pour la connexion `<NAME>` |
| `DB__<NAME>__SSLMODE` / `__SSLROOTCERT` / `__POOLSIZE` / `__ENGINE` / `__SYNC` | nommée | Options de la connexion `<NAME>` |
| `DB_MODULE_ROUTING={"token-trader":"analytics"}` | — | Route un `moduleId` vers une connexion |

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

## Câbler un module vers une connexion nommée

`dbFor(moduleId)` renvoie la connexion logique ; `connectionToken(...)` la convertit en token
d'injection NestJS (`undefined` pour `main`). À utiliser aux deux points de câblage :

```ts
const DB = connectionToken(dbFor('token-trader'));     // -> 'analytics' ou undefined
TypeOrmModule.forFeature([TokenEntity], DB)
@InjectRepository(TokenEntity, DB) repo
```

## Points d'extension

- Nouveau moteur cloud → étendre la liste `isCloud` dans `databases.ts`.
- Partition d'entités personnalisée → `resolveEntityGlobs`.

## Contraintes (toute connexion routée)

- ❌ Pas de jointure / clé étrangère / relation `@ManyToOne` **cross-DB**.
- ❌ Pas de transaction **cross-DB**.
- `synchronize` et migrations sont gérés **par connexion** (migrations sur `main` uniquement).
