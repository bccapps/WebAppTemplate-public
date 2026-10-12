# Prometheus Metrics — MyApp

## Vue d'ensemble

Chaque instance NestJS (replicas API + worker) expose un endpoint `/metrics` au format Prometheus text 0.0.4.

Un agent local **vmagent** (VictoriaMetrics Agent) scrape chaque container individuellement via le socket Docker, puis pousse les métriques vers un serveur Prometheus externe via `remote_write`. Aucune règle firewall entrante n'est nécessaire.

```
[back_1 /metrics]     ─┐
[back_2 /metrics]     ─┤── vmagent (Docker SD) ──► remote_write ──► Prometheus externe
[back-worker /metrics] ─┘
```

> Le vmagent bypasse le load balancer nginx (`back-lb`) en adressant chaque container directement sur le réseau Docker interne — chaque replica a sa propre série de métriques.

---

## Configuration

### 1. Variables d'environnement (`back/.env`)

Il y a deux credentials distincts avec deux rôles distincts :

```
vmagent ──[METRICS_TOKEN]──► GET /metrics (NestJS) ──[données]──► vmagent ──[PROMETHEUS_BASIC_AUTH]──► Prometheus
```

```env
# Token scraping : protège GET /metrics côté appli NestJS.
# vmagent l'envoie en Authorization: Bearer quand il scrape chaque container.
# Laisser vide pour désactiver (dev uniquement).
METRICS_TOKEN=<secret_aléatoire>

# Serveurs Prometheus qui reçoivent les métriques. LISTE séparée par des
# virgules : vmagent RÉPLIQUE les séries vers chaque destination.
# Vide = vmagent n'est pas démarré du tout.
PROMETHEUS_REMOTE_WRITE_URLS=https://prom1.example.com/api/v1/write,https://prom2.example.com/api/v1/write

# Credentials basic auth remote_write : authentifient vmagent auprès du serveur Prometheus externe.
# Correspondent aux entrées basic_auth_users dans web.yml de Prometheus.
PROMETHEUS_BASIC_AUTH_USER=<utilisateur_prometheus>
PROMETHEUS_BASIC_AUTH_PASSWORD=<mot_de_passe_prometheus>
```

> **Note architecture** : `METRICS_TOKEN` est passé à vmagent via `docker-compose.yml` et utilisé dans `vmagent.yml` (section `authorization` des scrape_configs). Les destinations et leurs identifiants sont passés par VARIABLES D'ENVIRONNEMENT (`VM_remoteWrite_url`, `VM_remoteWrite_basicAuth_username/password`) et non plus en flags CLI : `-remoteWrite.url` est répétable, et avec `-envflag.enable=true -envflag.prefix=VM_` un flag répétable se donne en une variable à valeurs séparées par des virgules — ce qu'une ligne `command:` de compose, qui ne peut pas boucler, ne permettrait pas.
>
> Les identifiants s'apparient aux URL **par position** : une seule valeur pour deux URL n'authentifierait que la première, les autres partant en anonyme pour être refusées en 401 — sans symptôme, vmagent réessayant indéfiniment en silence. `deploy-full.sh` duplique donc une valeur unique autant de fois qu'il y a d'URL.
>
> **Côté destinataire** : chaque Prometheus doit tourner avec `--web.enable-remote-write-receiver`, sinon `/api/v1/write` répond 404. Il n'y a alors ni cible ni série, donc aucune alerte pour le dire. La section `remote_write` de `vmagent.yml` n'existe pas pour vmagent — vmagent configure sa destination remote_write uniquement via flags CLI. Le reverse proxy nginx se contente de terminer TLS et de proxier `/api/v1/write` sans vérification de token — Prometheus valide lui-même les credentials.

**Exemples par provider :**

| Provider | `PROMETHEUS_REMOTE_WRITE_URLS` | Auth |
|----------|-------------------------------|------|
| Self-hosted Prometheus ≥ 2.25 | `https://prometheus.monserveur.com/api/v1/write` | `PROMETHEUS_BASIC_AUTH_USER/PASSWORD` — voir §3 |
| Grafana Cloud | `https://prometheus-prod-XX.grafana.net/api/prom/push` | Service Account token (voir §3) |
| VictoriaMetrics | `https://victoriametrics.monserveur.com/api/v1/write` | Optionnel |
| Grafana Alloy (local relay) | `http://alloy:9009/api/v1/push` | — |

### 2. Démarrer vmagent

**En production (via `deploy-full.sh`)** : vmagent démarre automatiquement si `PROMETHEUS_REMOTE_WRITE_URLS` est défini (le singulier `PROMETHEUS_REMOTE_WRITE_URL` reste accepté et est normalisé par le script) dans `back/.env`. Rien à faire de plus.

**Manuellement** (debug, preprod, test) : le service utilise un profil Docker Compose et ne démarre pas avec un `up` classique.

```bash
# Démarrer manuellement
docker compose -f scripts/docker-compose.yml --profile metrics up -d vmagent

# Vérifier les logs
docker logs myapp_vmagent --tail 50

# Arrêter
docker compose -f scripts/docker-compose.yml --profile metrics down vmagent
```

Le reste de la stack (`back`, `back-worker`, `back-lb`, etc.) se gère normalement sans `--profile metrics`.

### 3. Configuration côté serveur par provider

#### Self-hosted Prometheus

**Étape 1 — Activer le récepteur remote_write**

Prometheus désactive ce récepteur par défaut. Ajouter le flag au démarrage :

```
--web.enable-remote-write-receiver
```

**Étape 2 — Sécuriser le endpoint avec Basic Auth**

Prometheus supporte la Basic Auth nativement via `web.yml` (ou `web-config.yml`) :

```yaml
# web.yml
basic_auth_users:
  <utilisateur>: <hash_bcrypt>   # générer avec : htpasswd -nB <utilisateur>
```

Démarrer avec `--web.config.file=/etc/prometheus/web.yml`.

Cette Basic Auth protège tous les endpoints Prometheus (UI + `/api/v1/write`).

**Étape 3 — Reverse proxy nginx (TLS + port 9090 fermé)**

Le reverse proxy nginx termine TLS et proxie `/api/v1/write` vers Prometheus. Il ne vérifie pas de token supplémentaire — Prometheus valide lui-même les credentials. Port 9090 ouvert uniquement depuis l'IP du reverse proxy :

```bash
ufw allow from <ip-reverse-proxy> to any port 9090
ufw deny 9090
```

Config nginx pour `location /api/v1/write` :

```nginx
location /api/v1/write {
    proxy_pass          http://<ip-prometheus>:9090;
    proxy_http_version  1.1;
    proxy_set_header    Content-Type     $http_content_type;
    proxy_set_header    Content-Encoding $http_content_encoding;
    proxy_set_header    Host             $host;
}
```

> **Whitelist nginx obligatoire** : le `location /` du virtual host monitoring expose l'UI Prometheus avec une liste d'IPs autorisées (`allow`/`deny all`). **Ajouter l'IP publique de chaque serveur back** à cette whitelist pour permettre la consultation des métriques depuis ces serveurs. Sans cela, seuls les IPs déjà whitelistées (VPN, postes admin) peuvent accéder à l'UI — vmagent n'est pas affecté car il écrit sur `/api/v1/write` qui n'a pas de restriction IP.

Dans `back/.env` :
```env
PROMETHEUS_REMOTE_WRITE_URLS=https://prometheus.mondomaine.com/api/v1/write
PROMETHEUS_BASIC_AUTH_USER=<utilisateur_prometheus>
PROMETHEUS_BASIC_AUTH_PASSWORD=<mot_de_passe_en_clair>
```

---

#### Grafana Cloud

Grafana Cloud supporte les Bearer tokens via les **Service Accounts** (plus sécurisé que les API keys legacy) :

1. Cloud Portal → ton stack Grafana → **Administration → Users and access → Service accounts**
2. **Add service account** → rôle **MetricsPublisher**
3. Dans le service account créé → **Add service account token** → copier la valeur
4. `PROMETHEUS_REMOTE_WRITE_TOKEN=<service_account_token>`

L'URL remote_write est visible dans **Connections → Data sources → Prometheus → Settings**.

---

#### VictoriaMetrics self-hosted

VictoriaMetrics gratuit ne valide pas les Bearer tokens nativement — utiliser l'Option A (reverse proxy existant) ou laisser `PROMETHEUS_REMOTE_WRITE_TOKEN` vide et sécuriser au niveau réseau (VPN / firewall).

---

## Mise en service — checklist de vérification

Suivre ces étapes dans l'ordre. Chaque étape doit passer avant de continuer.

---

### Étape 1 — L'appli NestJS expose bien `/metrics`

Depuis le serveur qui héberge les containers (ou en SSH) :

```bash
# Sans token (si METRICS_TOKEN est vide)
curl -s http://localhost:${NODE_PORT}/metrics | head -5

# Avec token
curl -s -H "Authorization: Bearer <METRICS_TOKEN>" http://localhost:${NODE_PORT}/metrics | head -5
```

**Résultat attendu :** lignes commençant par `# HELP` ou `process_cpu_seconds_total`.

**Si 401 :** `METRICS_TOKEN` dans `.env` ne correspond pas à ce que tu passes en header.  
**Si connexion refusée :** le container `back` n'est pas démarré ou `NODE_PORT` est incorrect.

---

### Étape 2 — vmagent scrape les containers sans erreur

```bash
docker logs ${PROJECT_NAME}_vmagent --tail 100 2>&1 | grep -E "scrape|error|warn|401|403"
```

**Résultat attendu :** lignes de type `scrape duration` sans erreurs.  
**Si 401 :** `METRICS_TOKEN` absent ou incorrect dans `vmagent.yml` (section `authorization`).  
**Si "no targets" :** vmagent ne trouve pas les containers — vérifier le socket Docker et les labels de filtre dans `vmagent.yml`.

Vérifier les cibles découvertes par Docker SD :

```bash
docker logs ${PROJECT_NAME}_vmagent 2>&1 | grep -i "target"
```

---

### Étape 3 — vmagent envoie bien vers Prometheus

```bash
docker logs ${PROJECT_NAME}_vmagent --tail 100 2>&1 | grep -E "remoteWrite|remote_write|push|flush"
```

**Résultat attendu :** logs de push sans erreur HTTP.  
**Si 401 :** `PROMETHEUS_BASIC_AUTH_USER/PASSWORD` incorrects dans `back/.env`.  
**Si timeout / connexion refusée :** une des `PROMETHEUS_REMOTE_WRITE_URLS` inaccessible depuis le serveur — vérifier firewall et DNS.

Test direct de l'URL remote_write depuis le serveur :

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer <PROMETHEUS_REMOTE_WRITE_TOKEN>" \
  -H "Content-Type: application/x-protobuf" \
  -X POST <une des PROMETHEUS_REMOTE_WRITE_URLS>
```

**Codes attendus :** `204` (succès) ou `400` (payload vide, mais l'auth est OK).  
**Si `401` :** token refusé par le reverse proxy ou Prometheus.  
**Si `000` :** URL injoignable réseau.

---

### Étape 4 — Les données arrivent dans Prometheus

Attendre au moins 60 secondes (délai du cron `MetricsCollectorService`), puis interroger Prometheus :

```bash
# Self-hosted
curl -s 'https://prometheus.monserveur.com/api/v1/query?query=infra_cpu_percent' | jq .

# Grafana Cloud — via l'explorateur Grafana (Explore → Prometheus → infra_cpu_percent)
```

**Résultat attendu :** champ `result` non vide avec les labels `instance`, `job`, `project`.  
**Si `result: []` :** les métriques ne sont pas encore arrivées — vérifier les étapes 2 et 3.

---

### Résumé visuel du flux

```
[NestJS /metrics]
      ↑  METRICS_TOKEN (Bearer)
   vmagent
      ↓  PROMETHEUS_BASIC_AUTH_USER/PASSWORD (Basic auth, TLS)
[Reverse proxy nginx]
      ↓  (réseau interne, port 9090 fermé sauf proxy)
[Prometheus :9090]
```

Chaque flèche correspond à une étape de la checklist ci-dessus.

---

## Métriques disponibles

### Métriques custom (`infra_*`)

Mises à jour toutes les ~60 secondes par le cron de `MetricsCollectorService`.

| Métrique | Type | Description |
|----------|------|-------------|
| `infra_cpu_percent` | Gauge | CPU % (tous cœurs, vue processus) |
| `infra_memory_percent` | Gauge | RAM système % |
| `infra_memory_used_bytes` | Gauge | RAM système utilisée en octets |
| `infra_db_pool_active` | Gauge | Connexions PostgreSQL actives |
| `infra_db_pool_idle` | Gauge | Connexions PostgreSQL inactives |
| `infra_redis_connected` | Gauge | 1 = connecté, 0 = déconnecté |
| `infra_redis_latency_ms` | Gauge | Latence Redis en ms (-1 si indisponible) |

Toutes portent le label `instance` = nom du container Docker (ex: `myapp_back_1`).

### Métriques de charge applicative (`http_*`)

Mises à jour en temps réel par `HttpMetricsMiddleware` (appliqué à toutes les routes) — le signal principal pour juger si une instance sature et décider d'un scale.

| Métrique | Type | Labels | Description |
|----------|------|--------|-------------|
| `http_requests_total` | Counter | `instance`, `method`, `route`, `status_code` | Requêtes traitées. `route` = template Express (pas les IDs bruts). |
| `http_request_duration_seconds` | Histogram | `instance`, `method`, `route`, `status_code` | Durée de traitement (buckets 5ms–10s). |
| `http_requests_in_flight` | Gauge | `instance` | Requêtes en cours sur l'instance. |

### Métriques de contexte métier (`app_*`)

Mises à jour toutes les ~60 secondes par `UserMetricsCollectorService` (module `user`) — à corréler avec la charge pour distinguer une hausse de trafic due à la croissance utilisateurs d'une autre cause.

| Métrique | Type | Description |
|----------|------|-------------|
| `app_total_users` | Gauge | Nombre total d'utilisateurs (DB-wide). |
| `app_active_users_24h` | Gauge | Utilisateurs distincts avec une session active dans les dernières 24h. |

### Métriques Node.js standards (`process_*`, `nodejs_*`)

Fournies automatiquement par `prom-client collectDefaultMetrics` :

| Métrique | Description |
|----------|-------------|
| `process_cpu_seconds_total` | Temps CPU consommé (user + system) |
| `process_resident_memory_bytes` | RSS (mémoire physique allouée) |
| `process_heap_bytes` | Taille du tas V8 |
| `nodejs_eventloop_lag_seconds` | Latence event loop (détecte les blocages) |
| `nodejs_gc_duration_seconds` | Durée des GC par type (histogram) |
| `nodejs_active_handles_total` | Handles actifs (sockets, timers…) |
| `nodejs_version_info` | Version Node.js (label) |

---

## Labels Prometheus

Chaque série porte :

| Label | Valeur | Source |
|-------|--------|--------|
| `instance` | `myapp_back_1`, `myapp_back_2`, `myapp_back-worker_1` | Docker SD (container name) |
| `job` | `myapp_api` ou `myapp_worker` | vmagent scrape config |
| `role` | `api` ou `worker` | vmagent relabeling |
| `project` | `myapp` | `external_labels` dans vmagent.yml |

---

## Requêtes PromQL utiles

```promql
# CPU moyen sur toutes les instances
avg(infra_cpu_percent{project="myapp"})

# RAM max parmi les replicas API
max(infra_memory_percent{job="myapp_api"})

# Pool DB total (toutes instances)
sum(infra_db_pool_active{project="myapp"})

# Redis down sur au moins une instance
min(infra_redis_connected{project="myapp"}) == 0

# Event loop lag > 100ms (signe de blocage)
nodejs_eventloop_lag_seconds{project="myapp"} > 0.1

# Heap utilisé (worker)
process_heap_bytes{job="myapp_worker"}

# Débit par instance API (requêtes/s)
sum by (instance) (rate(http_requests_total{job="myapp_api"}[5m]))

# Taux d'erreur 5xx par instance
sum by (instance) (rate(http_requests_total{job="myapp_api", status_code=~"5.."}[5m]))
  / sum by (instance) (rate(http_requests_total{job="myapp_api"}[5m]))

# p95 de latence par route
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{project="myapp"}[5m])))

# Requêtes en cours par instance — seuil de saturation à calibrer par charge réelle
max by (instance) (http_requests_in_flight{project="myapp"})

# Croissance utilisateurs vs charge (mêmes valeurs sur chaque instance, prendre max)
max(app_total_users{project="myapp"})
max(app_active_users_24h{project="myapp"})
```

### Exemples de règles d'alerte scaling (à provisionner côté serveur Prometheus/Alertmanager — non versionnées ici)

```yaml
groups:
  - name: myapp_scaling
    rules:
      - alert: HighEventLoopLag
        expr: nodejs_eventloop_lag_seconds{project="myapp"} > 0.1
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "Event loop lag élevé sur {{ $labels.instance }} — Node.js proche de saturation" }

      - alert: HighErrorRate
        expr: |
          sum by (instance) (rate(http_requests_total{project="myapp", status_code=~"5.."}[5m]))
          / sum by (instance) (rate(http_requests_total{project="myapp"}[5m])) > 0.05
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "Taux d'erreur 5xx > 5% sur {{ $labels.instance }}" }

      - alert: HighP95Latency
        expr: histogram_quantile(0.95, sum by (le, instance) (rate(http_request_duration_seconds_bucket{project="myapp"}[5m]))) > 1
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "p95 latence > 1s sur {{ $labels.instance }} — envisager un scale" }
```

---

## Dépannage

> Pour un diagnostic complet depuis zéro, suivre la checklist de la section **Mise en service** ci-dessus.

### vmagent ne démarre pas
```bash
docker logs ${PROJECT_NAME}_vmagent --tail 100
```
Causes fréquentes :
- `PROMETHEUS_REMOTE_WRITE_URLS` vide ou mal formée
- `vmagent.yml` introuvable (vérifier que le fichier est bien dans `scripts/`)
- Socket Docker inaccessible (`/var/run/docker.sock` — vérifier les permissions)

### Les métriques `infra_*` sont à 0 ou absentes
Le cron `MetricsCollectorService` tourne toutes les 60 secondes — attendre une minute après le démarrage.
Si elles restent absentes, vérifier que `InfraModule.forRoot()` est bien appelé sans `enablePrometheus: false`.
