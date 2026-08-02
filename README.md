# TwitNin API - PostgreSQL Optimisée

API hypersophistiquée pour l'application TwitNin, optimisée pour les performances avec PostgreSQL.

## 🚀 Fonctionnalités

- **Base de données PostgreSQL** avec optimisations avancées
- **Authentification JWT** sécurisée
- **Cache Redis** pour les performances
- **Protection brute force** contre les attaques
- **Compression et optimisation** des réponses
- **Logging avancé** avec Winston
- **Validation des données** avec express-validator
- **Migrations automatiques** avec index optimisés
- **Tâches cron** pour la maintenance
- **Health checks** et monitoring

## 🛠️ Technologies

- **Node.js** avec Express
- **PostgreSQL** avec Sequelize ORM
- **Redis** pour le cache et la protection brute force
- **JWT** pour l'authentification
- **bcryptjs** pour le hachage des mots de passe
- **Winston** pour le logging
- **Docker** et Docker Compose

## 📋 Prérequis

- Node.js 16+ 
- PostgreSQL 13+
- Redis 6+
- Docker et Docker Compose (optionnel)

## 🚀 Installation

### 1. Cloner le projet
```bash
git clone <repository-url>
cd TwitNin/api
```

### 2. Installer les dépendances
```bash
npm install
```

### 3. Configuration de l'environnement
```bash
cp env.example .env
```

Modifier le fichier `.env` avec vos paramètres :
```env
# Base de données PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=twitninf
DB_USER=postgres
DB_PASSWORD=password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
JWT_SECRET=votre-secret-jwt-super-securise
```

### 4. Avec Docker (recommandé)
```bash
# Démarrer tous les services
docker-compose up -d

# Vérifier les services
docker-compose ps
```

### 5. Sans Docker
```bash
# Installer PostgreSQL et Redis localement
# Puis lancer les migrations
npm run migrate

# Peupler la base de données
npm run db:seed
```

## 🗄️ Base de données

### Migrations
```bash
# Créer les tables et index optimisés
npm run migrate

# Annuler les migrations
npm run migrate:down
```

### Seeding
```bash
# Créer des données de test de base
npm run db:seed

# Créer des données complètes
npm run db:seed -- --full
```

## 🚀 Démarrage

### Mode développement
```bash
npm run dev
```

### Mode production
```bash
npm start
```

L'API sera disponible sur `http://localhost:3000`

## 📊 Optimisations PostgreSQL

### Index créés automatiquement
- Index uniques sur `username`, `email`, `phone`
- Index GIN pour les recherches textuelles
- Index partiels pour les utilisateurs actifs
- Index sur les statistiques JSONB
- Index sur les dates pour les requêtes temporelles

### Extensions PostgreSQL
- `uuid-ossp` pour les UUID
- `pg_trgm` pour les recherches de similarité
- `btree_gin` pour les index GIN

### Vues optimisées
- `popular_users` : utilisateurs populaires
- `recent_users` : utilisateurs récents
- `global_stats` : statistiques globales

### Fonctions PostgreSQL
- `update_user_stats()` : mise à jour des statistiques
- `search_users()` : recherche optimisée d'utilisateurs

## 🔐 Sécurité & Système anti-fraude

### Architecture anti-fraude (3 couches)

```
Client → Nginx → Node API (fraudMiddleware.js) → Redis ← Rust (fraude-service-detector)
```

**Couche 1 — Pré-filtre Node.js synchrone (`quickScan`, ~0.1ms)** : détecte et bloque les attaques évidentes avant le contrôleur. Couvre : SQLi, CMDi, Path traversal, Null byte, CRLF injection, SSRF, XSS, XXE, SSTI, NoSQL injection, Prototype pollution, Log4Shell.

**Couche 2 — Blocklist Redis** : clé `fraud:blocked:ip:<ip>` avec TTL 24h. Consultée en ~1ms sur chaque requête avant tout traitement.

**Couche 3 — Service Rust** (`fraude-service-detector`) : analyse comportementale asynchrone. Score chaque requête par `userId` + IP. Quand le score dépasse le seuil, l'IP est bannie dans Redis.

### Autorisation forte des transactions

Tous les achats et mouvements de valeur passent par une preuve courte durée
produite par le moteur Rust avant la mutation du wallet. Le moteur combine une
référence personnelle robuste (médiane/MAD), la vélocité adaptative, les
liaisons appareil/réseau/instrument de paiement, le graphe des transferts et
l'historique de risque. La preuve est liée au contenu et à une clé
d'idempotence, puis consommée dans la même transaction PostgreSQL que le débit.

Les décisions sont `APPROVE`, `MONITOR`, `REVIEW` ou `DECLINE`; les mesures
wallet sont `NONE`, `MONITOR`, `RESTRICT` ou `FREEZE`. Une indisponibilité du
moteur bloque l'achat sans débiter le compte. Le casino est le seul flux exclu,
via un jeton interne non forgeable par une requête cliente.

La file de revue est disponible sur `GET /api/admin/economy/fraud-cases` et le
gel/dégel manuel sur `PUT /api/admin/economy/wallets/lock`.

### Scoring par userId (anti-faux positifs)

Le middleware extrait le `userId` depuis le JWT **avant même que l'auth middleware tourne**, en décodant directement le header `Authorization: Bearer ...`. Cela évite que des requêtes authentifiées soient scorées comme `anonymous` et déclenchent un ban IP à tort — notamment sur les IPs Cloudflare/mobiles partagées.

### Débloquer une IP manuellement

```bash
# Supprimer la clé Redis
redis-cli -a <REDIS_PASSWORD> DEL "fraud:blocked:ip:<ip>"

# Vider la réputation mémoire du service Rust (reset complet)
sudo systemctl restart fraude-service-detector.service
```

### Logs fraude en direct

```bash
# Logs du service Rust (scores, blocages)
sudo journalctl -u fraude-service-detector.service -f

# Filtré sur les blocages uniquement
sudo journalctl -u fraude-service-detector.service -f | grep -E "BLOCKED|added to"

# Logs API (requêtes bloquées)
sudo journalctl -u twitninf-api.service -f | grep fraud
```

### Protection brute force
- Limitation des tentatives de connexion
- Délais d'attente progressifs
- Stockage Redis pour la persistance

### Rate limiting
- Limitation globale par IP
- Limitation par utilisateur
- Configuration flexible

### Validation des données
- Validation stricte des entrées
- Sanitisation des données
- Protection contre les injections

## 📈 Performance

### Cache Redis
- Cache des requêtes fréquentes
- Session management
- Protection brute force

### Compression
- Compression gzip/brotli
- ETags pour le cache navigateur
- Optimisation des ressources statiques

### Optimisations base de données
- Pool de connexions optimisé
- Requêtes préparées
- Index stratégiques
- JSONB pour les données flexibles

## 🔧 API Endpoints

### Authentification
```
POST /api/auth/register     - Inscription
POST /api/auth/login        - Connexion
POST /api/auth/logout       - Déconnexion
POST /api/auth/refresh-token - Rafraîchir token
POST /api/auth/forgot-password - Mot de passe oublié
POST /api/auth/reset-password/:token - Réinitialiser mot de passe
GET  /api/auth/verify-email/:token - Vérifier email
```

### Profil utilisateur
```
GET  /api/auth/profile      - Obtenir profil
PUT  /api/auth/profile      - Mettre à jour profil
PUT  /api/auth/change-password - Changer mot de passe
GET  /api/auth/verify-auth  - Vérifier authentification
```

### Fonctionnalités spéciales
```
GET  /api/auth/premium-features - Fonctionnalités premium
GET  /api/auth/verified-features - Fonctionnalités vérifiées
GET  /api/auth/performance-test - Test de performance
GET  /api/auth/stats         - Statistiques utilisateur
GET  /api/auth/search        - Recherche d'utilisateurs
GET  /api/auth/popular       - Utilisateurs populaires
```

### Monitoring
```
GET  /health                - Health check
GET  /                      - Informations API
```

## 🧪 Tests

```bash
# Tests unitaires
npm test

# Tests avec couverture
npm run test:coverage
```

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:3000/health
```

### Logs
Les logs sont disponibles dans `logs/` :
- `app.log` : Logs généraux
- `error.log` : Logs d'erreurs

### Métriques
- Temps de réponse des requêtes
- Utilisation mémoire
- Connexions base de données
- Cache hit ratio

## 🔄 Tâches cron

- **Nettoyage sessions** : Toutes les heures
- **Optimisation DB** : Tous les jours à 2h
- **Sauvegarde stats** : Toutes les 6 heures

## 🐳 Docker

### Services disponibles
- **postgres** : Base de données PostgreSQL
- **redis** : Cache Redis
- **api** : API Node.js
- **pgadmin** : Interface PostgreSQL (port 5050)
- **redis-commander** : Interface Redis (port 8081)

### Commandes utiles
```bash
# Démarrer tous les services
docker-compose up -d

# Voir les logs
docker-compose logs -f api

# Arrêter les services
docker-compose down

# Reconstruire l'image
docker-compose build --no-cache
```

## 📝 Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|---------|
| `NODE_ENV` | Environnement | `development` |
| `PORT` | Port du serveur | `3000` |
| `DB_HOST` | Hôte PostgreSQL | `localhost` |
| `DB_PORT` | Port PostgreSQL | `5432` |
| `DB_NAME` | Nom base de données | `twitninf` |
| `DB_USER` | Utilisateur PostgreSQL | `postgres` |
| `DB_PASSWORD` | Mot de passe PostgreSQL | voir `.env` sur le VPS, jamais en clair ici |
| `REDIS_HOST` | Hôte Redis | `localhost` |
| `REDIS_PORT` | Port Redis | `6379` |
| `JWT_SECRET` | Secret JWT | valeur aléatoire forte (`openssl rand -hex 64`), voir `.env` sur le VPS |
| `FRAUD_DATA_HASH_KEY` | Secret HMAC distinct pour pseudonymiser appareil, IP et paiement | repli sur `JWT_SECRET` |

## 🤝 Contribution

1. Fork le projet
2. Créer une branche feature (`git checkout -b feature/AmazingFeature`)
3. Commit les changements (`git commit -m 'Add some AmazingFeature'`)
4. Push vers la branche (`git push origin feature/AmazingFeature`)
5. Ouvrir une Pull Request

## 📄 Licence

Ce projet est sous licence MIT. Voir le fichier `LICENSE` pour plus de détails.

## 🆘 Support

Pour toute question ou problème :
- Ouvrir une issue sur GitHub
- Consulter la documentation
- Vérifier les logs dans `logs/`

## 🔄 Migration depuis MongoDB

Si vous migrez depuis MongoDB :

1. Sauvegarder vos données MongoDB
2. Exporter vers JSON
3. Utiliser le script de migration pour convertir vers PostgreSQL
4. Vérifier l'intégrité des données

## 📸 Gestion des avatars

L'API utilise des URLs d'avatar par défaut. Pour personnaliser :

1. **Avatar par défaut** : Modifier `defaultAvatar` dans `config.js`
2. **Upload d'images** : Utiliser Multer et Sharp pour le traitement
3. **Stockage** : URLs externes ou stockage local dans `uploads/`

## 📈 Roadmap

- [ ] API GraphQL
- [ ] WebSocket pour temps réel
- [ ] Microservices
- [ ] Kubernetes deployment
- [ ] Monitoring avancé (Prometheus/Grafana)
- [ ] Tests E2E
- [ ] Documentation OpenAPI/Swagger
