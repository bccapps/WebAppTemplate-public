# Procédure de lancement d'un test de charge

Mode d'emploi **dans l'ordre** pour jouer un test de charge avec `scripts/loadtest`. Le détail des options, de la config et des
garde-fous est dans le [`README.md`](README.md) ; ici, seulement *quoi faire, quand, et comment tout remettre en état*.
Les étapes propres à un projet (infrastructure, valeurs, noms de machines) vivent dans la documentation du projet, qui renvoie
à cette procédure : voir « Étapes propres au projet » plus bas.

Toutes les commandes se lancent depuis la racine du projet : `node scripts/loadtest/loadtest.mjs <commande>`
(abrégé `lt` ci-dessous).

## Principes

1. **Aucun palier sans l'accord explicite du propriétaire de l'environnement.** `run` exige `--tier <nom>` (jamais « tous ») et
   `--confirm <hôte de l'API>` hors localhost : un palier ne part pas par accident.
2. **Tout ce qui est armé se désarme.** Trois choses modifient l'environnement le temps du test : la limite du limiteur de débit,
   l'exception Cloudflare, et (si le projet en a besoin) le scrape rapide. Chacune a sa commande inverse, listée à l'étape 5 ;
   les rappels de `run`, `check` et `teardown` ne remplacent pas cette étape.
3. **Un palier à la fois, du plus petit au plus grand**, et on ne monte pas si le précédent est `FAIL`.
4. **Un seul travail lourd sur la machine** : pas de build ni de suite de tests pendant un palier (le générateur serait chargé et
   le test s'arrêterait de lui-même, voir `generatorLoadRatio`).

| On arme | Commande | On désarme | Preuve du retour à l'état normal |
|---|---|---|---|
| Comptes de test | `lt setup` | `lt teardown` (puis `--hard`) | `.loadtest/users.json` ne contient plus de jetons |
| Limite du limiteur de débit | `lt throttle raise --tier …` | `lt throttle restore` (ou `lt teardown`) | `lt throttle show` = la valeur de production |
| Exception Cloudflare | `lt cloudflare allow` (ou règle posée à la main) | `lt cloudflare revoke` (ou retirer la règle) | `lt cloudflare check` : « bypass rule … NOT found » |
| Scrape rapide (si le projet le prévoit) | procédure du projet | procédure du projet | `lt check` : intervalles de scrape d'origine |

## 0. Prérequis (une fois par projet)

- `k6` installé (`k6 version`), Node ≥ 20.
- `lt init` a créé `loadtest.config.json`, `.loadtest/secrets.env` (droits 600, ignoré par git) et l'entrée `.gitignore`.
- `loadtest.config.json` renseigné : `targets`, `journeys` (pages réelles, pondérées), `tiers`, `monitor.prometheus.queries` avec `guard`,
  `limits`. Les parcours doivent refléter ce que fait vraiment le front (dont le chiffrement de transport : `model.crypt`).
- `.loadtest/secrets.env` rempli (jamais dans un message, un ticket ou le dépôt) :
  `LOADTEST_ADMIN_TOKEN` (token admin de l'environnement cible), `LOADTEST_PROM_USER` / `LOADTEST_PROM_PASSWORD`,
  `LOADTEST_BYPASS_KEY` si la règle Cloudflare est posée à la main, `CLOUDFLARE_API_TOKEN` (Zone Read + Zone WAF Edit/Write sur la
  zone testée) si on veut `cloudflare allow|revoke`.

## 1. Validation à blanc (la veille, ou au moins une heure avant)

Rien de lourd ici : on vérifie que tout est branché et que les parcours sont corrects *avant* d'y mettre de la charge.

1. **`lt plan`** — lire les estimations et les ⚠ de chaque palier prévu : trafic, opérations Redis, comptes partagés, débit
   anonyme par IP, débit d'ouverture de sessions chiffrées. Chaque ⚠ a une réponse dans l'étape 2 ou 3.
2. **`lt check`** — doit afficher des ✓ partout ; les ⚠ sont consultatifs (intervalle de scrape, budget de connexions, secret de
   contournement) et se lisent, ils ne bloquent pas. Un ✖ bloque : le corriger. `check` ne modifie rien.
3. **`lt setup`** — *écrit* : crée les comptes `<prefix>-NNN` et leurs jetons (tier choisi par `auth.tier`, `highest` par défaut).
   Reprenable si interrompu. Noter le tier choisi qu'il affiche : il fixe les fonctionnalités et les métriques déverrouillées.
4. **`lt probe`** — une requête GET par URL de chaque parcours, avec le premier compte de test et l'en-tête de contournement.
   Tout doit être ✓. Un `401` = jeton ou compte invalide ; un `403` = le tier ne donne pas accès (changer `auth.tier` ou la page) ;
   un `404`/`400` = chemin ou paramètre faux dans `journeys`. On corrige la config et on relance `probe` jusqu'à zéro ✖.
5. **`lt run --tier smoke --confirm <hôte api>`** — le plus petit palier, pour voir la chaîne complète tourner (k6, échantillons,
   rapport). Lire `.loadtest/runs/<id>/report.md` : verdict `OK`, aucun `429`, `Encrypted %` cohérent, aucune requête SQL ni page
   aberrante. Si le palier de fumée est `FAIL`, on ne passe pas à la suite.

## 2. Armer (environ 30 minutes avant)

1. **Fenêtre** : l'environnement est-il libre de vrais utilisateurs, ou a-t-on prévenu ceux qui pourraient être touchés ?
2. **Le générateur est au calme** : fermer navigateur et IDE lourds, pas de build en cours (vérifier la mémoire et la charge de la
   machine avant de commencer). Si on lance depuis une VM jetable, elle est proche de la cible et sans autre usage.
3. **Quotas des fournisseurs relevés avant** (ils ne sont lisibles par aucune API ici) : consommation de la base (connexions, egress),
   du cache (commandes, bande passante, mémoire), du CDN/WAF. On note les valeurs : l'étape 6 les compare.
4. **Scrape rapide**, si `lt check` a signalé un intervalle de scrape trop long pour les garde-fous : appliquer la procédure du projet
   et la vérifier (les comptes d'échantillons par minute doivent monter).
5. **Contournement Cloudflare** (si la cible est derrière Cloudflare) : soit `lt cloudflare allow` (crée la règle, enregistre son
   secret), soit une règle posée à la main (`lt cloudflare plan` imprime le JSON exact ; mettre sa valeur dans
   `LOADTEST_BYPASS_KEY`). Vérifier : **`lt cloudflare check`** doit afficher `bypass rule … found, position 1/…, action skip,
   enabled`. Sans règle active, le test mesurerait la protection Cloudflare et non l'origine.
6. **Limiteur de débit** si `plan` l'a demandé (anonymes depuis une seule IP) :
   `lt throttle raise --tier <palier> [--tier <autre>…]`, puis `lt throttle show`. Sans cela, `run` refuse de démarrer.
7. **Dernier `lt check`** : tous ✓ (le secret de contournement et la baseline sous les garde-fous y sont vérifiés).

## 3. Lancer

```bash
lt run --tier u50  --confirm <hôte api>        # un palier, on lit le rapport, puis…
lt run --tier u200 --confirm <hôte api>
lt run --tier u500 --confirm <hôte api>        # plusieurs --tier = enchaînés, avec une pause entre eux
```

- Les paliers lourds ou optionnels (ex. `u1000`) ne partent que s'ils sont nommés **et** que le précédent a été `OK`.
- **Pendant le palier** : la sortie de k6 (progression, erreurs), les tableaux de bord de supervision, et rien d'autre sur la machine.
- **Arrêts automatiques** : un garde-fou franchi (CPU, mémoire, boucle d'événements, connexions de base, mémoire du cache, charge du
  générateur) ou un seuil k6 (erreurs, p95) arrête k6 proprement ; le palier est marqué `aborted` avec la raison et les paliers
  suivants sont annulés. C'est un **résultat** (le point de saturation), pas une panne.
- **Arrêt manuel** : `Ctrl-C` dans le terminal du CLI. k6 s'arrête, les paliers restants sont annulés, le palier en cours est marqué
  `interrupted by the operator`, le rapport est quand même écrit. Si le terminal est perdu, `pkill -f "k6 run"` suffit (le CLI voit k6
  mourir et clôt le palier comme anormal). Dans les deux cas : **passer directement à l'étape 4**.
- Le rapport est écrit dans `.loadtest/runs/<id>/report.md` à la fin du dernier palier (ou de l'arrêt) ; `lt report <id>` le régénère.

## 4. Désarmer (tout de suite après, y compris après un arrêt ou un échec)

Dans cet ordre, en vérifiant chaque fois :

1. `lt throttle restore` (ou `lt teardown`, qui le fait aussi) → `lt throttle show` doit rendre la limite de production.
2. `lt cloudflare revoke` si la règle vient de `allow` ; sinon **retirer la règle posée à la main** du tableau de bord
   → `lt cloudflare check` : `bypass rule … NOT found`. Effacer aussi `LOADTEST_BYPASS_KEY` de `secrets.env`.
3. Scrape rapide : procédure de retour du projet → vérifier que les intervalles d'origine sont revenus.
4. Aucun palier ne tourne plus : `pgrep -fl "k6 run"` ne renvoie rien.

## 5. Nettoyer

1. **`lt teardown`** — révoque les jetons de test et supprime les comptes par l'API admin (suppression logique, comptes anonymisés ;
   les lignes restent en base). Relancer si des échecs sont listés : `users.json` conserve les comptes restants.
2. **`lt teardown --hard`** (si le projet ne veut rien laisser) — *dry run* par défaut : affiche le nombre de lignes par table dans
   une transaction annulée ; relire, puis `lt teardown --hard --apply` pour valider. Refuse tout compte qui n'est pas `<prefix>-*`.
3. **Secrets** : retirer `LOADTEST_ADMIN_TOKEN` de `.loadtest/secrets.env` et, si ce token n'avait pas d'autre usage, le révoquer
   ou le faire tourner côté environnement.

## 6. Analyser

1. Ouvrir `report.md` : résultats par palier (req/s, p50/p95/p99, erreurs, 429, 5xx, `Encrypted %`, verdict), pics de ressources avec la
   machine la plus chargée, p95 par page, commandes cache mesurées vs estimées, requêtes SQL les plus coûteuses, extrapolation.
2. **Comparer avec les consoles des fournisseurs** relevées à l'étape 2 (consommation base, cache, CDN) : ce que le test a réellement
   consommé de chaque abonnement.
3. **Conclure** : jusqu'à quel palier l'environnement est `OK` ; quel facteur a limité (CPU, connexions de base, p95 d'une page,
   limiteur) ; l'extrapolation n'est qu'indicative (≥ 3 paliers, pas d'effet de seuil ni de cache).
4. **Archiver** le rapport dans la documentation du projet (le dossier `.loadtest/` est ignoré par git) avec la date, le palier atteint
   et les décisions prises.

## 7. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `refusing to run against <hôte>` | `--confirm` absent ou différent de l'hôte de l'API | `--confirm <hôte exact>` |
| `these tiers need a rate limit of ~N/min` | anonymes d'une seule IP au-dessus du limiteur | `lt throttle raise --tier …` (ou `--ignore-throttle` en connaissance de cause) |
| `baseline already above a guard` | une limite est déjà franchie *avant* le test | regarder laquelle ; attendre la fin de l'activité en cours ou corriger la cause |
| Palier `aborted: prometheus/host_cpu_pct …` | saturation réelle d'une machine | résultat valide ; ne pas monter ; la machine nommée est la limite |
| Palier `aborted: generator/load_ratio …` | la machine qui génère la charge est saturée : mesures invalides | libérer la machine ou utiliser un autre générateur ; refaire le palier |
| `k6 threshold` ou `k6 ended abnormally` | erreurs ou p95 au-delà des `limits`, ou k6 tué | lire la sortie k6 ; vérifier `meta.json` du palier |
| `429` dans le rapport | limiteur de débit (ou limite de la route de session) | vérifier `throttle show` ; un palier avec des 429 mesure le limiteur, pas la capacité |
| `Encrypted %` < 100 sur les anonymes | la route de session chiffrée a sa propre limite par IP | attendu depuis une seule IP ; sans conséquence tant que les séries lourdes sont côté comptes |
| Pages de défi ou `403` Cloudflare | l'en-tête de contournement n'arrive pas | `lt cloudflare check`, valeur de `LOADTEST_BYPASS_KEY`, règle active et première |
| `probe` : `401` sur les parcours enregistrés | jeton de test invalide (compte supprimé, secret JWT changé) | `lt teardown` puis `lt setup` |
| `probe` : `403` sur une métrique | le tier des comptes ne la déverrouille pas | changer `auth.tier` (puis `teardown`/`setup`) ou la métrique du parcours |
| `check` : un job Prometheus « scraped every 60 s » | garde-fous machine en retard de 1 à 3 minutes | scrape rapide (étape 2.4) ou montées en charge plus lentes |
| `teardown` liste des échecs | limite de débit de l'API admin, ou compte déjà supprimé | relancer `lt teardown` |
| On a oublié de désarmer | — | reprendre l'étape 4 point par point ; `lt check` signale une limite encore relevée, et `lt run` rappelle limite et exception à sa fin |

## 8. Check-list à copier

```
AVANT (J-1)
[ ] lt plan lu, lt check sans ✖, lt setup fait, lt probe sans ✖, lt run --tier smoke OK
ARMER (H-30)
[ ] fenêtre validée      [ ] générateur au calme      [ ] quotas fournisseurs notés
[ ] scrape rapide (si besoin)   [ ] lt cloudflare check : bypass rule found, position 1, skip, enabled
[ ] lt throttle raise (si plan l'a demandé), lt throttle show vérifié   [ ] dernier lt check tout ✓
LANCER
[ ] palier 1 → rapport lu → palier suivant seulement si OK
DÉSARMER (tout de suite)
[ ] lt throttle restore + show = valeur de prod   [ ] règle Cloudflare retirée + LOADTEST_BYPASS_KEY effacée
[ ] scrape remis   [ ] plus de "k6 run" en cours
NETTOYER
[ ] lt teardown   [ ] lt teardown --hard (dry run relu, --apply)   [ ] token admin retiré / révoqué
ANALYSER
[ ] rapport lu   [ ] consoles fournisseurs comparées   [ ] rapport archivé dans la doc du projet
```

## Étapes propres au projet

Un projet qui a des étapes supplémentaires (scrape rapide d'un Prometheus, exception réseau, valeurs, noms de machines, personnes à
prévenir) les décrit dans sa propre documentation, sous la forme d'une procédure qui reprend les numéros ci-dessus et y insère ses
commandes. Le dossier du projet est la source de ces valeurs ; ce fichier-ci reste générique.
