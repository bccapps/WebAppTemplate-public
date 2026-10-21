# AppTemplate · front/ — fichiers frontend partagés

Copies **canoniques** des fichiers de config frontend mutualisés entre projets
React+Vite+TS.

Récupération en **symlink relatif** depuis la racine d'un projet :

```bash
node scripts/link-config.mjs
```

Mapping dans `../config-links.json`. Un vrai fichier côté projet = override
conservé (jamais clobbé).

| Type | Mécanisme | Exemples |
|---|---|---|
| Identiques | symlink pur | `eslint.config.js`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.app.json` |
| Env-injection | symlink + ENV | `vite.config.ts` (ports/hosts/proxy via env), `index.html` (title/favicon), `nginx.conf` (`${BACKEND_UPSTREAM}`) |
| Template | envsubst / ARG | `Dockerfile` |
| Base + local + merge | `build-package.mjs` | `package.base.json` + `<module>/package.fragment.json` (modules liés) + `package.local.json` → `package.json` ; `.env.example` du gabarit + `env` des `module.json` + `.env.example.local` → `.env.example` |

Artefacts **générés, jamais partagés ni trackés** : `vite.config.js`,
`vite.config.d.ts`, `*.tsbuildinfo`.

Voir `../MUTUALIZATION_PLAN.md` pour le détail et l'avancement des phases.
