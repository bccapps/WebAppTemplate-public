# SQLite test harness (opt-in)

Copy these files into an app's `back/test/` to run a Jest suite against the **real SQLite engine** (`better-sqlite3`), next to the usual Postgres e2e suite.

| File | Role |
|---|---|
| `jest-e2e-sqlite.json` | Jest config: `*.sqlite-spec.ts` files, `setupFiles` + `globalSetup` below |
| `e2e-setup-sqlite.ts` | Forces `DATABASE_ENGINE=sqlite`, `DB_PATH`, `TYPEORM_SYNC=true` **before** any entity is imported (decorators read the engine at import time) |
| `e2e-global-setup-sqlite.ts` | Starts every run from an empty database file under `back/.tmp/e2e-sqlite/` (never your dev database) |
| `example.sqlite-spec.ts` | Minimal spec: the app's entities synchronise and a JSON + date round trip works |

Adopt it:

1. `cp -R .libs/apptemplate/back/sqlite-harness/{jest-e2e-sqlite.json,e2e-setup-sqlite.ts,e2e-global-setup-sqlite.ts,example.sqlite-spec.ts} test/` (adjust `jest-resolver` / `moduleNameMapper` in the JSON if the app's `test/jest-e2e.json` differs).
2. Add to `back/package.local.json`: `"test:sqlite": "jest --config ./test/jest-e2e-sqlite.json --runInBand"` and make sure `better-sqlite3` is a dependency (`package.local.json`).
3. `npm run test:sqlite`.

What the engine setting does for the entities (automatic adaptation of `jsonb`/`timestamptz`/enums/arrays, SQL helpers, no migrations) is described in `nest/common/README.md` ("Database portability") and `nest/database/README.md`. `npm run db:check` is the fast, database-free version of this check.
