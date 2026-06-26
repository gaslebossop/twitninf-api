# Twitninf API — Contexte Claude

## Accès VPS

- **IP** : `51.210.11.74`
- **User** : `debian`
- **Clé SSH** : `C:\Users\nouno\OneDrive\Bureau\Documents\privatessh`
- **Commande de connexion** :
  ```bash
  ssh -i "C:\Users\nouno\OneDrive\Bureau\Documents\privatessh" debian@51.210.11.74
  ```
- **Connexion uniquement par clé SSH** (pas de mot de passe)

## Exécuter une commande sur le VPS

```bash
ssh -i "C:\Users\nouno\OneDrive\Bureau\Documents\privatessh" debian@51.210.11.74 "COMMANDE"
```

## Stack technique

| Service      | Détail                              |
|--------------|-------------------------------------|
| **API**      | Node.js (Express) — port 3001       |
| **Proxy**    | Nginx — port 80 → 3001              |
| **DB**       | PostgreSQL 17 — `localhost:5432`    |
| **Cache**    | Redis — `localhost:6379`            |
| **OS**       | Debian 13 (trixie) — amd64         |

## Chemins importants sur le VPS

| Chemin                          | Description                  |
|---------------------------------|------------------------------|
| `/home/debian/api/`             | Répertoire de l'API          |
| `/home/debian/api/.env`         | Variables d'environnement    |
| `/home/debian/api/api.log`      | Logs de l'API                |
| `/home/debian/targeting/`       | Module targeting (stub)      |
| `/home/debian/brain-engine/`    | Module brain-engine (stub)   |
| `/var/backups/twitninf/`        | Backups PostgreSQL           |

## Variables d'environnement (.env)

```
NODE_ENV=production
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=twitninf
DB_USER=admin
DB_PASSWORD=myytree88
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=twitninf-super-secret-key-2024
CORS_ORIGIN=*
```

## Commandes utiles

```bash
# Voir les logs de l'API en temps réel
sudo journalctl -u twitninf-api.service -f

# Redémarrer l'API
sudo systemctl restart twitninf-api.service

# Status de tous les services
sudo systemctl status twitninf-api nginx postgresql redis-server

# Backup manuel de la DB
/home/debian/backup_db.sh

# Voir les backups existants
ls -lh /var/backups/twitninf/

# Déployer une mise à jour du code depuis la machine locale
cd "C:\Users\nouno\OneDrive\Bureau\IAFILTRE\api" && tar -czf - --exclude=node_modules --exclude=.git . | ssh -i "C:\Users\nouno\OneDrive\Bureau\Documents\privatessh" debian@51.210.11.74 "cd /home/debian/api && tar -xzf - && npm install --production && sudo systemctl restart twitninf-api"
```

## Sécurité

- **Firewall (ufw)** : ports ouverts — 22 (SSH), 80 (HTTP), 443 (HTTPS)
- **fail2ban** : 3 tentatives SSH échouées → ban 24h
- **Redis** : bind localhost uniquement
- **PostgreSQL** : bind localhost uniquement
- **SSH** : authentification par clé uniquement, root désactivé

## Backup automatique

- **Fréquence** : toutes les 48h (systemd timer `twitninf-backup.timer`)
- **Rétention** : 10 derniers backups
- **Vérifier le timer** : `sudo systemctl list-timers twitninf-backup.timer`
