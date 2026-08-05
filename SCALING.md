# Architecture à deux VPS — état déployé

**Déployé et vérifié le 2026-08-05.** Ce document décrit ce qui tourne
réellement, pas une cible.

```
                twitninf.duckdns.org  (DNS DuckDNS → 51.210.11.74)
                              │
              ┌───────────────▼──────────────────────────────┐
              │ VPS A — 51.210.11.74 — 12 Go / 6 vCPU        │
              │  nginx (TLS + répartiteur)                   │
              │  ├─ twitninf-api  :3001   NODE_ROLE=web      │
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

- **Réparti entre A et B** : tout le trafic API, en `ip_hash` (un client reste
  collé à un nœud — nécessaire au repli polling de socket.io ; les diffusions,
  elles, traversent les nœuds via Redis).
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
> worker n'est pas exposé et ne sert qu'à `/api/health`.

> **PolicierCongo ne s'exécute que sur A.** Nginx épingle son chat, V3, admin et
> debug sur A. B porte `POLICIERCONGO_LOCAL_ENABLED=false`, refuse un appel
> direct avec 503 et n'initialise ni moteur ni provider Codex.

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

## Ce qui n'est pas fait

- **Pas de bascule automatique.** Si A tombe, B sert encore le trafic API mais
  ne peut pas promouvoir seul la réplique ni servir les médias de A.
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
