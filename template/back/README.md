# AppTemplate · back/ — fichiers backend partagés

Copies **canoniques** des fichiers de config backend mutualisés entre projets
NestJS.

Chaque projet les récupère en **symlink relatif** via :

```bash
# depuis la racine d'un projet
node scripts/link-config.mjs
```

Le mapping source→cible vit dans `../config-links.json`. Le linker ne clobbe
jamais un fichier réel : un projet qui veut sa propre version garde simplement
un vrai fichier à cet emplacement (override projet conservé).

| Type | Mécanisme | Exemples |
|---|---|---|
| Identiques | symlink pur | `config/Datasource.ts`, `fileLogger.ts`, `test-setup.ts`, `.env.example`, `tsconfig.build.json`, `.dockerignore`, `.gitignore` |
| Env-injection | symlink + ENV | `main.ts` (Swagger/body/DB/CORS via env) ; l'essentiel du démarrage HTTP (helmet, CORS, rawBody, ValidationPipe, `HOST`, `TRUST_PROXY`, `RAW_BODY_PATHS`) vit dans `modules_shared/common/bootstrap` (`configureHttpApp`) |
| Base + extends | `extends` natif TS | `tsconfig.base.json` ← `tsconfig.json` projet |
| Base + inject | symlink ou local | `nest-cli.base.json` (+ assets proto si besoin) |
| ARG | symlink + build-arg | `Dockerfile.base`, `Dockerfile` (`ARG NESTCLI_VERSION`) |
| Config jest | symlink (`config-links.json`) | `jest.config.js` (roots = projet + libs, via `scripts/lib-roots.mjs`) ; la clé `jest` de `package.local.json` est fusionnée par-dessus (`scripts/merge-jest.mjs` : objets fusionnés clé à clé — `moduleNameMapper`, `transform` —, tableaux/scalaires remplacés ; `build-package.mjs` retire `jest` du `package.json` généré) |
| Base + local + merge | `build-package.mjs` | `package.base.json` + `<module>/package.fragment.json` (modules liés) + `package.local.json` → `package.json` |

Voir `../MUTUALIZATION_PLAN.md` pour le détail et l'avancement des phases.

## `locales/` — socle `common.*.json` générique

`locales/common.{en,fr}.json` est le socle **canonique** des clés i18n génériques
réutilisables (formulaires, statuts, actions, config…) — le pendant, en version
git-trackée, de ce que chaque app maintient dans son propre
`back/src/locales/common.{en,fr}.json`. Contrairement au reste de ce dossier,
**pas de symlink** : chaque app garde un vrai fichier local (le contenu diverge
légitimement par app), synchronisé via `npm run locales:sync`
(`../scripts/sync-common-locales.mjs`, aussi lancé par `update_common.sh`) qui
n'ajoute que les clés canoniques manquantes — il n'écrase jamais une valeur déjà
présente côté app et signale les clés locales qui dupliquent déjà une clé
canonique sous un autre nom.

Un `common.*.json` ne doit jamais être un symlink vers un fichier local non versionné
partagé entre apps sans rapport (couplage silencieux) : ce mécanisme l'évite.
