# VXFramework WebAppTemplate

An opinionated full-stack web application template: a **NestJS + TypeORM + Postgres** back end and a
**React + Vite + TypeScript** front end, assembled from reusable modules.

## What is in this repository

| Path | Content |
|---|---|
| `template/` | The app template: shared scripts (`run.sh`, deploy, backup, `create-project.sh`...), Dockerfiles, base `package.base.json`, lint/TS config, minimal back/front skeleton |
| `nest/common`, `react/common` | Core modules (configuration, i18n, HTTP, crypto transport, email, theming, hardened HTTP bootstrap `configureHttpApp`, public `GET /api/v1/health`...) |
| `nest/database` | Multi-connection TypeORM helpers |
| `nest/voice`, `react/voice` | Voice module |
| `tools/` | `check-boundaries.mjs`, `license-headers.mjs`, `ci-sandbox.sh`, `ci-git-flow.sh`, `allowed.json` |

## Quick start

```bash
./template/scripts/create-project.sh my-app ~/projects        # add --with-private if you have access to WebAppTemplate-private
```

The script scaffolds a monorepo (`front/`, `back/`), mounts the libraries under `back/.libs` and `front/.libs`,
generates the `.env.dev` files and installs dependencies. Then `./scripts/run.sh dev` starts everything.

Libraries are mounted in **each** stack (Node resolves dependencies from the real path of a file):

```
back/.libs/vx-public    back/.libs/vx-private    back/.libs/apptemplate  -> vx-public/template
front/.libs/vx-public   front/.libs/vx-private   front/.libs/apptemplate -> vx-public/template
```

The modules a project uses are listed in `shared-modules.json` (see `template/shared-modules.json.example`).

## Anonymous mode (no user module)

User management is enabled **only** when a `user` module is listed in `shared-modules.json`. This repository does
not ship one. Without it the application runs anonymously: no login button, no wallet/web3 dependency in the
bundle, and the `/admin/*` area is protected by a single secret:

- set `ADMIN_TOKEN` in the back-end environment (empty value = admin disabled);
- the front end asks for the key once on `/admin/*`, keeps it in `sessionStorage` and sends it as
  `Authorization: Bearer <key>`.

For a single-user local application there is an opt-in **local trust mode**: with `LOCAL_TRUST=true` (and `HOST=127.0.0.1`, enforced at startup) requests that really come from the loopback interface with a local `Host` and `Origin` are administrators without a key. It never applies to remote clients or cross-site pages, and has no effect when a `user` module is linked. See `nest/common/README.md`.

## Plugging in private modules

Put your own modules in `back/.libs/vx-private/nest/<module>` and `front/.libs/vx-private/react/<module>` and list
them in `shared-modules.json`. Resolution order: `vx-public`, then `vx-private`. A module present in both is an
error. Rule: a public module never imports a private one; a private module may import public ones.
`tools/check-boundaries.mjs` enforces it.

## Development of this repository

```bash
node --test template/scripts/*.test.mjs template/tools/*.test.mjs
node tools/check-boundaries.mjs --root . --stack-dirs nest,react --allowed tools/allowed.json
node tools/check-boundaries.mjs --root . --stack-dirs nest,react --check-manifests --visibility public
node tools/license-headers.mjs --root . --license mit --check
tools/ci-sandbox.sh anonymous      # wizard-created anonymous project: builds back + front, runs the back tests
tools/ci-sandbox.sh anonymous-sqlite  # same as anonymous with the SQLite engine (DATABASE_ENGINE=sqlite, better-sqlite3, entity discovery on a SQLite file)
tools/ci-sandbox.sh multi-users    # same with multi-user accounts + sales, using a fake vx-private (SANDBOX_PRIVATE=<dir> for a real one)
tools/ci-git-flow.sh       # create-project / update_common / deploy staging against local bare origins
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
