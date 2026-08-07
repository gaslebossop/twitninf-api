# Architecture A/B avec autoscaling local — état déployé

**Déployé et vérifié le 2026-08-05.** Ce document décrit ce qui tourne
réellement, pas une cible.

```
                twitninf.duckdns.org  (DNS DuckDNS → 51.210.11.74)
                              │
              ┌───────────────▼──────────────────────────────┐
              │ VPS A — 51.210.11.74 — 12 Go / 6 vCPU        │
              │  nginx (TLS + répartiteur)                   │
              │  ├─ twitninf-api  :3001   NODE_ROLE=web      │
              │  ├─ C1…C32 :3005…3132  NODE_ROLE=web          │
              │  │    └─ répliques créées à la demande        │
              │  ├─ twitninf-api-worker :3004 NODE_ROLE=worker│
              │  │    └─ crons, PolicierCongo, radars         │
              │  ├─ Postgres 17 (primaire) + Redis           │
              │  ├─ MÉDIAS (storage/ + src/public/*)         │
              │  ├─ rust-recommender :3002                   │
              │  ├─ fraude-service-detector                  │
              │  └─ twitninf-stream                          │
              └───────────────┬──────────────────────────────┘
                    WireGuard wg0 — 0,7 ms
                 10.8.0.1  ◄──────►  10.8.0.2
              ┌───────────────▼──────────────────────────────┐
              │ VPS B — 51.255.48.125 — 3,7 Go / 2 vCPU      │
              │  ├─ twitninf-api-web    :3001  NODE_ROLE=web │
              │  └─ Postgres 17 (réplique de lecture)        │
              │       └─ shared_buffers=512MB, feedback=on   │
              │  + 2 Go de swap                              │
              └──────────────────────────────────────────────┘
```

Le **même code** tourne partout ; c'est `NODE_ROLE` qui décide du comportement.

## Répartition du trafic

- **Réparti entre A et B** : tout le trafic API, en hash cohérent pondéré 13:7
  (environ 65 % sur A et 35 % sur B). Un client reste collé à un nœud —
  nécessaire au repli polling de socket.io ; les diffusions, elles, traversent
  les nœuds via Redis. La pondération reflète les 6 vCPU de A contre 2 sur B et
  évite la saturation observée sur B avec l'ancien partage 50/50. Le mode
  `consistent` ne remappe qu'une petite partie des clients quand C apparaît ou
  disparaît, ce qui protège les sessions socket.io actives.
- **Lectures sous semi-surcharge** : après deux fenêtres où A dépasse 400 ms de
  p95 ou 2 % d'erreurs, GET/HEAD basculent sur le pool `twitninf_api_read`.
  Douze cycles calmes (une minute) rétablissent le partage normal.
  Ce biais ne change que la **proportion** de trafic envoyée à B : depuis le
  2026-08-07, B sert ses SELECT de GET/HEAD sur son PostgreSQL local **en
  permanence**, pas seulement en surcharge (voir « Réplique PostgreSQL de
  lecture »). Mutations, transactions et lectures effectuées pendant un
  POST/PUT/DELETE restent sur le writer courant.

### Le report de lecture ne fonctionnait pas (corrigé le 2026-08-07)

Il était décrit ici, implémenté dans l'autoscaler… et **sans aucun effet en
production**. La configuration Nginx vivante n'avait ni le `map $request_method`
ni l'upstream `twitninf_api_read` : la version versionnée du dépôt n'avait
jamais été posée sur la machine. L'autoscaler écrivait donc consciencieusement
`/etc/nginx/twitninf-read-routing.map`, un fichier que **personne n'incluait**,
et journalisait `read_bias_changed` sans que rien ne bouge.

> **Leçon générale** : `nginx -t` valide une configuration, il ne dit pas
> laquelle est servie. Vérifier avec `diff /etc/nginx/sites-available/… deploy/…`
> avant de conclure qu'une fonctionnalité de routage est active. C'est le second
> piège de ce type sur ce fichier (voir aussi le lien symbolique plus bas).

Deux corrections en même temps que la pose :

- **Les C sont désormais inclus dans le pool de lecture.** Ils en étaient
  absents : activer le report de lecture les excluait du trafic GET/HEAD —
  l'essentiel du trafic — au moment précis où l'autoscaler venait de les créer
  pour absorber la pointe. Les deux mécanismes se neutralisaient.
- **Poids revus** pour que B prenne réellement le relais : A-main passe de 7 à
  **4**, B de 13 à **20**.

Répartition mesurée sur 200 clients distincts (adresses source de loopback — le
hash `$binary_remote_addr consistent` colle un client à un nœud, donc une seule
IP ne prouve rien) :

| Backend | Report éteint | Report actif |
|---|---|---|
| **B** | 11 % | **35 %** |
| A-main | 25 % | 7 % |
| C1 + C2 + C3 | 64 % | 58 % |

Chaque requête déviée vers B est une requête que le PostgreSQL de A ne voit
plus. **Un C, lui, ne soulage que le CPU de Node** : il interroge la même base
que A. B est donc le seul levier qui soulage réellement le primaire, ce qui
justifie qu'il soit privilégié dans ce pool et pas dans l'autre.

### Le garde-fou sur B était un seuil absolu — il ne pouvait jamais céder

Même une fois la configuration Nginx posée, le report ne se déclenchait
toujours pas sous charge réelle. La condition était :

```python
wants_read_bias = a_semi_high and not b_high   # b_high = seuil ABSOLU
```

Or B franchit ce seuil absolu en même temps que A, parce que ses dépendances
(Redis, recommandeur Rust) vivent sur A : quand A sature, B ralentit par
ricochet. Relevé du run de 1 000 VU du 2026-08-07 01:38, pendant lequel le
report ne s'est jamais activé :

| | p95 | erreurs |
|---|---|---|
| A | 7,4 – 9,9 s | jusqu'à 4,8 % |
| **B** | **3,6 – 5,3 s** | **0 %** |

B était deux fois plus rapide que A et sans une seule erreur, et pourtant jugé
« surchargé ». Le mécanisme censé secourir A était neutralisé précisément
quand A allait mal.

Remplacé par une **comparaison** (`b_can_absorb_reads`) : la bonne question
n'est pas « B va-t-il bien ? » mais « B va-t-il mieux que A ? ». B doit être au
moins 10 % plus rapide que A (`AUTOSCALE_READ_BIAS_B_P95_RATIO`) et ne pas
casser plus que lui d'un point (`AUTOSCALE_READ_BIAS_B_ERROR_MARGIN`), avec un
minimum d'échantillons. Déplacer des lectures vers un nœud moins bon serait
absurde ; vers un nœud meilleur, ça reste utile même si aucun des deux n'est
confortable.

Vérifié end-to-end sur un run de 1 000 VU (02:00) : le report s'est activé à
02:00:43 et éteint à 02:02:14 avec la fin de la charge. Répartition relevée
dans le journal Nginx, fenêtrée sur ces deux périodes :

| Backend | Report éteint | Report actif |
|---|---|---|
| **A (process principal)** | **28,8 %** | **12,4 %** |
| B | 19,7 % | 16,7 % |
| C1 / C2 / C3 | ~25 % chacun | ~23,6 % chacun |

**A est soulagé de plus de la moitié de sa part** — c'est l'objectif. Mais B
n'atteint que 16,7 % au lieu des ~32 % que ses poids visent.

> **Piste identifiée, non corrigée : `worker_shutdown_timeout` n'est pas défini
> dans `nginx.conf`.** Après un `reload`, les anciens workers survivent tant que
> des connexions client restent ouvertes — et un générateur de charge maintient
> les siennes pendant tout le run. Une part des requêtes a donc continué d'être
> routée par la configuration d'*avant* l'activation du report, ce qui tire la
> répartition observée vers les anciens poids. Poser
> `worker_shutdown_timeout 30s;` bornerait ce délai, **mais couperait aussi les
> connexions socket.io de plus de 30 s à chaque rechargement** : à arbitrer,
> pas à appliquer à la légère.

> Rappel de cadrage : ce mécanisme **déplace** de la charge, il n'en crée pas.
> Au même run, les cinq nœuds étaient à 10 s de p95 et 12 % d'erreurs pour
> ~112 rps. Router mieux ne remplace pas de la capacité manquante.
- **Épinglé sur A** : `/storage/`, `/static/`, toutes les routes
  `/api/**/policiercongo*`, et les cinq points d'entrée qui reçoivent un fichier
  — `/api/users/me/avatar`, `/api/users/me/banner`, `/api/tweets/video`,
  `/api/stories`, et la pièce jointe de conversation.
  Un upload traité par B écrirait sur **son** disque, où personne ne peut le
  relire. Config versionnée : [deploy/nginx-twitninf-api.conf](deploy/nginx-twitninf-api.conf).

## Règles à ne pas enfreindre

> **Un seul process au monde a `NODE_ROLE=worker`** — aujourd'hui
> `twitninf-api-worker` sur A, port 3004. C'est ce qui garantit que PolicierCongo,
> TwitNinfAI et les purges ne tournent qu'en un exemplaire. `NODE_ROLE` absent
> vaut `all`, donc **compte comme un worker** : ne jamais démarrer un process
> sans cette variable. `./deploy-vps.sh --check` le vérifie.

> **Les médias vivent sur A.** Toute nouvelle route qui reçoit un fichier doit
> être ajoutée aux `location` épinglés dans la config nginx, sinon les fichiers
> déposés via B seront introuvables.

> **Le worker écoute sur 3004**, pas 3001 : deux process ne peuvent pas se lier
> au même port. Le port 3003 de A appartient à `fraud-dashboard`. Le port du
> worker n'est pas exposé directement ; Nginx y épingle seulement le cockpit
> `/api/admin/infrastructure/` afin que celui-ci puisse rallumer API A ou B.

> **PolicierCongo ne s'exécute que sur A.** Nginx épingle son chat, V3, admin et
> debug sur A. B porte `POLICIERCONGO_LOCAL_ENABLED=false`, refuse un appel
> direct avec 503 et n'initialise ni moteur ni provider Codex.

## Continuité PostgreSQL — ⚠️ NON DÉPLOYÉE

> **Cette section décrivait un mécanisme qui n'existe pas sur les machines.**
> Vérifié le 2026-08-07 : **rien n'écoute sur le port 6432**, ni sur A ni sur B.
> Le HAProxy d'écriture n'a jamais été installé ; [deploy/install-twitninf-postgres-ha.sh](deploy/install-twitninf-postgres-ha.sh)
> est présent dans le dépôt mais n'a pas été appliqué.

L'état réel : chaque API parle à PostgreSQL **en direct**, sans indirection.

| Process | `DB_HOST` (écritures) |
|---|---|
| `twitninf-api` (A:3001) et `twitninf-api-worker` (A:3004) | `localhost` |
| `twitninf-api-web` (B:3001) | `10.8.0.1` — **l'IP de A, en dur** |

Conséquence à connaître avant de compter dessus : **si PostgreSQL A s'arrête, B
s'arrête avec lui**, bien que son standby soit intact à 0,7 ms de là. Il n'y a
aucun point de reconfiguration à basculer, donc le bouton « arrêter la base A »
du cockpit ne peut pas promouvoir B de façon utile.

Ce qu'il faudrait pour que la bascule existe vraiment :

1. Installer le HAProxy local sur `127.0.0.1:6432` et faire pointer les deux
   `.env` dessus — c'est ce qui rend la promotion de B invisible aux pools
   Sequelize.
2. Accepter que ça ne couvre que « PostgreSQL A s'arrête ». Le TLS, Nginx et le
   DNS pointent toujours sur A : **l'extinction du VPS A reste une panne
   totale**, quoi qu'on fasse côté base. Ça demanderait une IP flottante avec
   fencing.

Le standby B dispose de 1 Go de `shared_buffers`, d'un
`effective_cache_size` de 2,5 Go et préchauffe les tables principales avec
`pg_prewarm` après son redémarrage.

## Autoscaling des C sur A

Le timer `twitninf-autoscaler.timer` évalue le trafic toutes les 5 secondes à
partir d'un journal Nginx minimal qui ne contient ni URI, ni IP, ni jeton. Une
surcharge globale d'au moins 60 requêtes sur 30 secondes déclenche un scale-out
à partir de 800 ms de p95 ou 5 % d'erreurs serveur. Tant que l'épisode reste
mauvais, les cycles suivants peuvent ajouter d'autres C.

Chaque C est un process PM2 isolé sur A : C1 `:3005`, C2 `:3006`, C3 `:3007`,
puis C4–C32 utilisent la plage isolée `:3104`–`:3132`.
Il écoute uniquement sur `127.0.0.1`, porte obligatoirement `NODE_ROLE=web` et
`POLICIERCONGO_LOCAL_ENABLED=false`, puis passe `/api/health/live` avant
d'entrer dans Nginx. Cette sonde ne touche ni PostgreSQL, ni Redis : un service
annexe lent ne peut plus expulser un C vivant pendant une surcharge. La liste
d'upstreams est écrite
atomiquement, validée par `nginx -t`, et restaurée si le reload échoue.

Garde-fous : plafond technique de 32 C, mais limite réelle calculée avec la RAM
disponible ; 1,5 Go budgété par C, 4,5 Go disponibles avant une création et
3 Go conservés après. Les C démarrent strictement un par un, puis sont retirés
un par un après 10 minutes stables ou sans trafic. Le fichier Nginx est la
source de vérité : les processus PM2 orphelins sont supprimés et le dump PM2
est resauvegardé, ce qui empêche leur retour aléatoire après un déploiement.
PolicierCongo reste le seul worker sur A:3004 pendant tout le cycle.

### Réactivité (revue le 2026-08-07)

| Réglage | Avant | Après | Effet |
|---|---|---|---|
| `AUTOSCALE_WINDOW_SECONDS` | 30 | **15** | moitié moins de latence de détection |
| `AUTOSCALE_MAX_SCALE_OUT_BATCH` | 1 | **2** | uniquement sur le chemin catastrophique |
| `AUTOSCALE_WARMUP_SECONDS` | 3 | **1** | 4 réponses consécutives suffisent |
| Intervalle de sondage | 1 s | **250 ms** | on constate la disponibilité tout de suite |
| `AUTOSCALE_LOW_STREAK` | 120 (10 min) | **36 (3 min)** | retrait plus rapide |
| `AUTOSCALE_IN_COOLDOWN_SECONDS` | 600 | **120** | un retrait toutes les 2 min |

**Création d'un C mesurée : 20,5 s → 3,0 s.** Le process lui-même répond à
`/api/health/live` en 1,6 s ; le reste était du sondage à gros grain et un
warmup calibré pour l'époque où un C mettait ~10 s à démarrer.

> Le plancher restant, ce sont les invocations du CLI `pm2` (`delete`, `start`,
> `save`), qui paient chacune un démarrage de Node. C'est là qu'il faudrait
> creuser pour descendre encore.

### Piège : `disabled_replicas` bloque tout, en silence

Un C arrêté manuellement est ajouté à `disabled_replicas` dans
`/var/lib/twitninf-autoscaler/state.json` et **n'en sort jamais tout seul**.
Le 2026-08-07, C4 à C32 y étaient tous — 29 entrées — et C1/C2/C3 tournaient :
la liste des candidats était donc vide, et l'autoscaler « ne faisait plus
rien » sans la moindre erreur. Le bouton du panneau Windows renvoyait un
succès (`code: 0`) pour la même raison : la commande s'exécutait, mais n'avait
aucun C à démarrer.

À vérifier en premier quand plus aucun C n'apparaît :

```bash
sudo /usr/local/sbin/twitninf-autoscaler --status | python3 -m json.tool | grep -A2 disabled
```

Pour tout réhabiliter sans démarrer les process, vider la liste dans
`state.json` (sauvegarder le fichier d'abord).

Un C arrêté manuellement reste désactivé, même si les mesures des 15 secondes
précédentes sont encore hautes. L'autoscaler peut choisir un autre numéro ; le
bouton **Démarrer** réactive explicitement le C arrêté.
Tout arrêt manuel suspend aussi les scale-out automatiques pendant 90 secondes,
le temps que la fenêtre de mesures se vide. Le workflow de déploiement pose une
pause de maintenance de 180 secondes avant les reloads : leurs 5xx transitoires
ne peuvent donc plus créer de C.

Le backend du panneau n'accepte qu'une commande C à la fois. Son PID est
persisté dans `reports/admin-load/autoscaler-control.json` ; les clics doublés
ou concurrents reçoivent un HTTP 409 au lieu de s'empiler et de s'exécuter dans
un ordre imprévisible. Le panneau désactive tous les boutons jusqu'à la fin.

Le panneau pilote aussi directement les processus web A/B et PostgreSQL A/B,
sans passer par le verrou de l'autoscaler. A exécute les commandes locales via
`twitninf-infra-control`; B reçoit uniquement les sept commandes autorisées par
une clé SSH dédiée et une forced-command. « Arrêter A/B » retire le processus
API correspondant du trafic, mais n'éteint pas le système du VPS : Nginx et le
worker de contrôle restent donc joignables pour le redémarrer. L'arrêt de la
base primaire A exige une confirmation textuelle et rend les écritures
indisponibles jusqu'à son redémarrage.

Commandes opérateur sur A :

```bash
sudo /usr/local/sbin/twitninf-autoscaler --status
sudo /usr/local/sbin/twitninf-autoscaler --force-up
sudo /usr/local/sbin/twitninf-autoscaler --force-down
sudo /usr/local/sbin/twitninf-autoscaler --start c1
sudo /usr/local/sbin/twitninf-autoscaler --restart c1
sudo /usr/local/sbin/twitninf-autoscaler --delete c1
journalctl -u twitninf-autoscaler.service --since '30 min ago'
```

Les seuils sont dans `/etc/default/twitninf-autoscaler`. Les fichiers sources
sont `deploy/twitninf-autoscaler.py`, les unités systemd associées, le format de
journal `deploy/nginx-twitninf-autoscale-log.conf` et
`deploy/install-twitninf-autoscaler.sh`.

### Ce qu'un C fait à son démarrage (allégé le 2026-08-07)

L'autoscaler sonde `/api/health/live`, donc un C entre dans Nginx dès que le
`listen()` est passé. Tout ce qui bloque **avant** ce `listen()` est du délai
pur, subi au pire moment — pendant une surcharge.

Trois initialisations s'y trouvaient, et aucune n'était le travail d'un nœud web :

| Appel | Ce qu'il fait réellement |
|---|---|
| `behaviorDataMigration.initializeOnStartup()` | crée des tables, migre des lignes, écrit les préférences par défaut de tous les comptes — une migration |
| `initVirtualCurrency()` | parcourt **toute** la table `users` et crée les portefeuilles manquants — un seed |
| `transactionAuthorizationService.initialize()` | 4 `CREATE TABLE` + 6 `CREATE INDEX` — un DDL |

À quoi s'ajoutait `behaviorDataLoader.initializeOnStartup()`, du préchauffage de
cache qui chargeait les profils des 100 utilisateurs les plus actifs **en
parallèle**. Autrement dit : chaque C créé pour soulager un primaire saturé
commençait par lui envoyer une centaine de requêtes et des écritures
concurrentes, avant de servir quoi que ce soit.

Les trois premières sont désormais réservées au process qui porte déjà les
migrations (`runMigrations`), et le préchauffage au worker. Les nœuds web
gardent le chargement paresseux, qui a son propre TTL et qui est de toute façon
le seul chemin emprunté par le moteur de recommandation.

**La garantie fail-closed du registre de transactions est conservée** : un nœud
web ne construit plus le schéma, il le *constate* via `_assertSchema()` — une
lecture de `to_regclass` qui échoue franchement si une table manque. L'API
refuse toujours de démarrer sans registre durable ; seul le coût a disparu.
Corollaire : **le worker doit avoir démarré au moins une fois** pour qu'un nœud
web puisse démarrer sur une base neuve.

Mesures sur A, `/api/health/live` :

| | Avant (boots du 25/07, 4 relevés concordants) | Après (3 relevés) |
|---|---|---|
| Bloc comportemental | 8 s | sauté |
| Amorçage cryptomonnaie | 2 s | sauté |
| **Total bloquant avant `listen()`** | **~10 s** | **~1,4 s** |

Le worker, lui, joue toujours la séquence complète (11 s au boot du 2026-08-07) —
c'est voulu, c'est son rôle.

> ⚠️ Le « ~40 s » cité plus bas pour le déploiement n'a jamais été le délai d'un
> C : il correspond à `/api/health` **complet**, qui attend le modèle
> d'embeddings chargé *après* le `listen()`. L'autoscaler n'attend pas ça.

> Ce mécanisme absorbe des pointes dans la limite des 6 vCPU et de la RAM de A ;
> il ne transforme pas un seul VPS en capacité infinie. Le canari 10 000 VU a
> saturé A immédiatement : les C réduisent le risque et le délai, mais une vraie
> garantie à cette échelle demanderait des machines supplémentaires externes.

## Le recommandeur Rust est partagé par les deux nœuds

`rust-recommender` ne tourne que sur A. Son adresse d'écoute était **codée en
dur** à `127.0.0.1` : B ne pouvait pas l'atteindre, et son instance web
retombait silencieusement sur le classement JS (`[NeuralRank] Rust service
unavailable, using JS fallback`) tout en **perdant les événements CTR** de
`/api/track` qui alimentent le modèle ML. Symptôme côté utilisateur : des
recommandations étranges une fois sur deux.

Corrigé : `RUST_BIND_HOST` (défaut `127.0.0.1`, réglé à `0.0.0.0` sur A via un
drop-in systemd), le port 3002 n'est ouvert qu'à `10.8.0.2` par ufw, et B
pointe sur `RUST_RECOMMENDER_URL=http://10.8.0.1:3002`.

> **Toute dépendance qui ne tourne que sur A doit être joignable par le
> tunnel.** Une URL en `localhost` dans le `.env` de B se dégrade en silence :
> le code a des replis, donc rien n'échoue franchement — c'est la qualité du
> service qui baisse sans alerte.

## Déploiement

Automatique à chaque push sur `main` via
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) : les hôtes sont
traités **l'un après l'autre** (pendant qu'un nœud redémarre, l'autre sert), et
si le premier rate son contrôle de santé le second n'est pas touché. Le
workflow vérifie aussi qu'il n'existe qu'un seul worker.

Secret à ajouter au dépôt : **`VPS_HOST_B`** = `51.255.48.125`. Sans lui, le
workflow ne déploie que sur A et le signale en avertissement.

Manuellement :

```bash
cd api && HOSTS="debian@51.210.11.74 debian@51.255.48.125" ./deploy-vps.sh
```

Le script exclut les médias, le `.env` et les données générées, recharge sans
coupure, attend que `/api/health` réponde (le démarrage prend ~40 s : chargement
du modèle d'embeddings) et vérifie qu'il n'y a qu'un seul worker.

## Deux pièges rencontrés en production — à connaître

**1. `config.redis` était au format node-redis v3.** En v4 (la version
installée), `host` au premier niveau est **ignoré** : le client se rabat
silencieusement sur `127.0.0.1`. Tant que Redis tournait sur la même machine
que l'API, le bug était invisible — le défaut se trouvait être la bonne valeur.
La première instance distante a échoué en `ECONNREFUSED` sans que `REDIS_HOST`
apparaisse dans l'erreur. Corrigé dans `src/config/config.js` : le bloc
`socket: { host, port }` est celui qui compte. Même piège pour
`FRAUD_REDIS_URL`, qui contient l'hôte en dur dans l'URL.

**2. `sites-enabled/twitninf-api` était un fichier réel, pas un lien** (à la
différence de `twitninf-stream` juste à côté). Modifier `sites-available` ne
changeait donc rien, et `nginx -t` validait la nouvelle config sans qu'elle ne
soit jamais servie. C'est désormais un lien symbolique. **Vérifier avec
`ls -la /etc/nginx/sites-enabled/` avant de conclure qu'une config est active.**

## Vérifier que tout va bien

```bash
cd api && HOSTS="debian@51.210.11.74 debian@51.255.48.125" ./deploy-vps.sh --check
```

`/api/health` expose `role`, `instance` et `read_replica`. Pour prouver la
répartition, comparer le nombre de requêtes vues par B avant/après une rafale :

```bash
ssh -i <clé> debian@51.255.48.125 "pm2 logs twitninf-api-web --lines 2000 --nostream | grep -c 'GET /api/health'"
```

Preuves collectées au déploiement : deux canaux de réponse `socket.io-response#`
dans Redis (les deux nœuds sont abonnés → diffusion inter-nœuds active), clés
`rl:*` dans Redis (rate limit partagé), un seul `/api/health` avec
`role="worker"` sur A:3004, et `[pc3] Scheduler non démarré sur ce process
(role != worker)` dans les logs des deux process web.

## Réplique PostgreSQL de lecture

- A reste le primaire PostgreSQL 17.10 ; B suit en réplication physique
  asynchrone via le slot `vps_b` et le tunnel WireGuard.
- B n'écoute que sur `localhost` et `10.8.0.2:5432`. UFW n'autorise ce port que
  depuis `10.8.0.1` sur `wg0`.
- Le worker de A porte `DB_READ_HOST=10.8.0.2`, `DB_READ_PORT=5432` et un petit
  pool dédié. Seules les lectures explicitement sûres passent par `queryRead` :
  veille d'usurpation, radar de tendances et calculs de vélocité. Les écritures,
  migrations et relectures sensibles restent toujours sur le primaire.
- Une panne de la réplique replie automatiquement ces lectures sur A. La santé
  et le retard de rejeu sont exposés dans `/api/health.read_replica`.

### Le web de B lit sur son standby local (depuis le 2026-08-07)

Avant cette date, la réplique était **saine mais branchée sur rien** : elle
n'avait aucun consommateur en dehors des trois services de veille du worker,
qui sont du batch. `DB_ORM_READ_HOST` n'était défini nulle part, donc B
envoyait **100 % de ses SELECT à travers WireGuard vers le primaire de A**. B
absorbait 35 % du trafic HTTP sans soulager la base d'un seul octet — c'était
la cause du « la réplique ne sert à rien » constaté à l'usage.

B porte désormais `DB_ORM_READ_HOST=127.0.0.1` / `DB_ORM_READ_PORT=5432`. Le
routage était déjà écrit et n'attendait que cette variable :

- [config/config.js](src/config/config.js) n'ajoute le bloc `replication` de
  Sequelize que si `DB_ORM_READ_HOST` est renseigné — donc A n'est pas affecté.
- [database/requestReadRouting.js](src/database/requestReadRouting.js) marque la
  requête HTTP en cours dans un `AsyncLocalStorage`, et
  [models/index.js](src/models/index.js) force sur le writer tout `SELECT` qui
  n'appartient pas à un GET/HEAD.

> **C'est ce garde-fou qui rend l'option sûre.** Le mode `replication` nu de
> Sequelize enverrait sur le standby *tous* les SELECT hors transaction, y
> compris les « je crée puis je relis pour renvoyer l'objet » — la réplication
> étant asynchrone, chacun deviendrait un bug silencieux. **Ne jamais définir
> `DB_ORM_READ_HOST` sur un nœud dont le code n'a pas ce middleware monté.**

Vérification faite au déploiement : 40 GET sur B ont fait progresser
`pg_stat_database.tup_returned` du standby local de **+41 584 lignes**, et le
standby porte des connexions applicatives permanentes (pool de lecture). Avant
la bascule, ce compteur ne bougeait pas pour du trafic API.

Le risque résiduel est la lecture périmée : un client collé à B qui poste puis
recharge lit son standby local. Le retard de rejeu mesuré est de **0 octet**,
donc marginal en pratique — mais c'est le point à surveiller si des « mon tweet
n'apparaît pas » remontent.

### Ce qui limite réellement B — ce n'est ni son CPU ni sa base

Relevé pendant une vraie surcharge (benchmark `TwitninfClusterCapacity`,
~130 rps sur le parc, 2026-08-07 01:24–01:29) :

| | B | A |
|---|---|---|
| Charge / vCPU | **0,96 sur 2** | 4,61 sur 6 |
| CPU du process Node | **0,37 cœur** | 0,88 cœur (process principal) |
| PostgreSQL local | 2,4 % CPU, 1 requête active | — |
| Connexions du pool | **9 sur 100** | 26 sur 100 |
| p95 | 5,8 s | 7,7 s |

B affichait le p95 le plus mauvais du parc à certains moments **tout en
n'utilisant que 0,37 cœur et 9 connexions**. Il n'était donc ni limité par son
CPU, ni par sa base, ni par son pool : **il attendait**. Ses dépendances vivent
toutes sur A — Redis (`REDIS_HOST=10.8.0.1`) et le recommandeur Rust
(`RUST_RECOMMENDER_URL=http://10.8.0.1:3002`) — et A était saturé.

Deux conséquences pratiques :

- **Augmenter le pool de B ne sert à rien** tant qu'il en utilise 9 sur 100. Et
  `pool.max` de Sequelize s'applique aussi à son pool d'**écriture vers A** :
  l'augmenter mangerait le budget de connexions du primaire sans contrepartie.
- **Lui envoyer plus de lectures est gagnant des deux côtés** : ça soulage A, et
  comme la lenteur de B est héritée de la saturation de A, B s'améliore aussi.

Piste non traitée : B garderait un cache local (Redis local pour les clés de
lecture pure) au lieu de traverser WireGuard vers un Redis déjà sous pression.
Ça casserait le rate-limit partagé et la diffusion socket.io s'il était utilisé
tel quel — à cadrer avant de s'y lancer.

### Journalisation des requêtes lentes (standby de B)

`log_min_duration_statement = 1s` est actif sur le standby depuis le
2026-08-07 (posé par `ALTER SYSTEM` + `pg_reload_conf()`, sans redémarrage).
Il n'y a **pas** de `pg_stat_statements` sur ce serveur — l'installer demande
`shared_preload_libraries` et donc un redémarrage de PostgreSQL. En attendant,
les requêtes de plus d'une seconde vues par B atterrissent dans le journal
PostgreSQL, ce qui donne de quoi optimiser sur des données réelles plutôt qu'au
jugé. Les relire après une campagne de charge :

```bash
sudo journalctl -u postgresql@17-main --since '1 hour ago' | grep 'duration:'
```

## Capacité mesurée, et une piste écartée par la mesure

Courbe à paliers relevée le 2026-08-07 (`clusterLoadBenchmark`, 1 000 comptes
synthétiques, 5 s de pause entre deux actions, départ à zéro réplique C) :

| Utilisateurs simultanés | Débit | p50 | p95 | Erreurs |
|---|---|---|---|---|
| 100 | 20,1 rps | 46 ms | 102 ms | 0 % |
| 250 | 49,6 rps | 48 ms | 139 ms | 0 % |
| 500 | **98,5 rps** | 92 ms | **513 ms** | 0 % |
| 1000 | 121 rps | 2 757 ms | 7 828 ms | 0,5 % |

**Le débit tenable est d'environ 98 rps**, et le mur se situe entre 500 et
1 000 utilisateurs simultanés. Au-delà, l'effondrement est brutal.

### Le cache de feed partagé était une mauvaise piste

L'hypothèse : les moteurs de recommandation cachaient en mémoire de process,
donc cinq caches tièdes au lieu d'un chaud. Mutualiser dans Redis semblait
promettre un facteur 5 à 20. **La mesure dit l'inverse.**

| Utilisateurs | Sans cache | Avec cache |
|---|---|---|
| 100 | 20,1 rps · p95 102 ms | 20,1 rps · p95 166 ms |
| 250 | 49,6 rps · p95 139 ms | 48,9 rps · p95 614 ms |
| 500 | 98,5 rps · p95 513 ms · 0 % | **46,0 rps · p95 10 001 ms · 21 %** |

Taux de hit relevé : **34 %**. La cause est structurelle, pas un réglage. Une
réponse de feed est **personnelle**, et un utilisateur ne redemande pas la même
page assez souvent pour qu'un TTL de 30 s serve à quelque chose. Les deux tiers
de requêtes restantes paient alors un aller-retour Redis, un `JSON.stringify`
sur des instances Sequelize imbriquées, puis une écriture en trois commandes.
On ajoute du coût à 66 % du trafic pour en économiser sur 34 %.

Le module `src/services/feedCache.js` est conservé, testé, et **désactivé par
défaut** (`FEED_CACHE_ENABLED=true` pour le réactiver en connaissance de cause).

### Ce que ces mesures éliminent

- **PostgreSQL n'est le goulot sur aucun des deux nœuds.** Avec
  `log_min_duration_statement = 1s` actif sur les deux : **zéro** requête lente
  sur le standby de B, **8** sur le primaire de A pour toute une soirée de
  tests de charge. Optimiser du SQL ne rapporterait rien.
- **Cacher les réponses ne marche pas** — mesuré ci-dessus.

Reste donc la couche applicative Node elle-même. La prochaine étape utile est
un profilage CPU d'un process web sous charge (`--cpu-prof` ou `0x`), pas une
nouvelle hypothèse. Et le cache qui aurait du sens n'est pas celui des réponses
mais celui des **objets partagés** entre utilisateurs : hydratation des tweets
par identifiant, profils d'auteurs, compteurs d'engagement — 775 tweets pour
des milliers de lecteurs, la réutilisation y est massive.

## Ce qui n'est pas fait

- **Pas de bascule PostgreSQL du tout.** Pas seulement « pas automatique » : le
  HAProxy `127.0.0.1:6432` décrit plus haut n'existe pas sur les machines, et
  B pointe l'IP de A en dur. Si la base de A s'arrête, B s'arrête avec elle.
  C'est le chantier (d) — voir « Continuité PostgreSQL ».
- **Pas de pool chaud pour les C.** Leur démarrage est passé de ~10 s à ~1,4 s,
  mais s'y ajoutent toujours la fenêtre de mesure de 30 s et le démarrage
  strictement séquentiel. Garder C1/C2 démarrés hors upstream Nginx réduirait le
  scale-out à un rechargement Nginx (< 1 s), au prix d'environ 2 Go de RAM
  immobilisés sur A.
- **Pas de stockage objet.** Les médias restent sur le disque de A.

## Dette repérée pendant le déploiement

- **28 Go de core dumps** dans `/home/debian/api/core.*` (11 fichiers de 2,6 Go,
  tous datés des 23-24 juillet). L'API a segfaulté en rafale à cette période ;
  plus rien depuis, et rien dans le journal noyau des 7 derniers jours.
  Supprimables : `rm -f /home/debian/api/core.*`.
- **Ancien mot de passe Postgres** présent en clair dans `setup_vss.sh`, donc
  dans l'historique Git rendu public. Sa valeur est volontairement omise ici ;
  il doit être rotaté.
- **Mot de passe Redis** faible et réutilisé. Sa valeur est volontairement
  omise ici et doit être remplacée.
- **Une panne de l'API le 2026-08-05 vers 04:25** : `connect() failed
  (111: Connection refused)` sur `127.0.0.1:3001` dans le journal nginx, sur des
  `POST /api/auth/login`. À creuser si ça se reproduit.
