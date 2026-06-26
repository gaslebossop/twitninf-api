# 🛡️ Système de Modération - API TwitNin

Ce document décrit l'implémentation complète du système de modération pour l'API TwitNin, incluant les signalements, l'analyse et l'historique.

## 🚀 Fonctionnalités Implémentées

### 1. 📋 Gestion des Signalements (Reports)
- **Table `reports`** : Stockage des signalements utilisateurs/tweets
- **Types** : tweet, user, comment
- **Statuts** : pending, investigating, resolved, dismissed
- **Gravité** : low, medium, high, critical
- **Priorité** : 1-5 (1 = plus haute priorité)

### 2. 📊 Analyse et Statistiques
- **Statistiques utilisateurs** : total, actifs, suspendus, bannis
- **Statistiques tweets** : total, en attente de modération
- **Statistiques signalements** : par statut et gravité
- **Statistiques actions** : par type et statut
- **Tendances temporelles** : 7j, 30j, 90j

### 3. 📚 Historique de Modération
- **Table `moderation_actions`** : Toutes les actions effectuées
- **Types d'actions** : ban, suspend, delete, warn, approve, reject
- **Statuts** : active, expired, reversed
- **Traçabilité complète** : qui, quoi, quand, pourquoi

## 🗄️ Structure de la Base de Données

### Table `reports`
```sql
CREATE TABLE reports (
  id UUID PRIMARY KEY,
  type VARCHAR(20), -- tweet, user, comment
  reporter_id UUID REFERENCES users(id),
  target_id UUID,
  target_type VARCHAR(20),
  reason TEXT,
  severity VARCHAR(20), -- low, medium, high, critical
  status VARCHAR(20), -- pending, investigating, resolved, dismissed
  priority INTEGER,
  moderator_notes TEXT,
  resolved_at TIMESTAMP,
  resolved_by UUID REFERENCES users(id),
  resolution_action VARCHAR(20),
  resolution_reason TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

### Table `moderation_actions`
```sql
CREATE TABLE moderation_actions (
  id UUID PRIMARY KEY,
  type VARCHAR(20), -- ban, suspend, delete, warn, approve, reject
  target_type VARCHAR(20), -- user, tweet, comment
  target_id UUID,
  moderator_id UUID REFERENCES users(id),
  reason TEXT,
  duration INTEGER, -- en jours
  status VARCHAR(20), -- active, expired, reversed
  expires_at TIMESTAMP,
  reversed_at TIMESTAMP,
  reversed_by UUID REFERENCES users(id),
  reversal_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

## 🔧 Installation et Configuration

### 1. Exécuter la Migration
```bash
cd TwitNin/api
node migrate-moderation-tables.js
```

### 2. Vérifier les Tables
```bash
# Se connecter à PostgreSQL
psql -h localhost -U username -d database_name

# Lister les tables
\dt

# Vérifier la structure
\d reports
\d moderation_actions
```

### 3. Tester l'API
```bash
# Test complet
node test-moderation-complete.js

# Test spécifique
node test-content-moderation.js
```

## 📡 Endpoints API

### Signalements
- `GET /api/moderation/reports` - Liste des signalements
- `GET /api/moderation/reports/:id` - Détails d'un signalement
- `PUT /api/moderation/reports/:id/status` - Mettre à jour le statut

### Statistiques
- `GET /api/moderation/stats` - Statistiques générales
- `GET /api/moderation/trends?period=7d` - Tendances temporelles

### Historique
- `GET /api/moderation/history` - Historique des actions
- `GET /api/moderation/users/:id/history` - Historique d'un utilisateur

### Gestion des Utilisateurs
- `GET /api/moderation/users` - Liste des utilisateurs
- `POST /api/moderation/users/:id/ban` - Bannir un utilisateur
- `POST /api/moderation/users/:id/suspend` - Suspendre un utilisateur
- `POST /api/moderation/users/:id/verify` - Vérifier un utilisateur

### Modération de Contenu
- `GET /api/moderation/tweets` - Tweets à modérer
- `POST /api/moderation/tweets/:id/approve` - Approuver un tweet
- `POST /api/moderation/tweets/:id/reject` - Rejeter un tweet

## 🔐 Permissions et Rôles

### Rôles Requis
- **moderator** : Accès de base à la modération
- **admin** : Accès étendu + gestion des modérateurs
- **superadmin** : Accès complet + configuration système

### Permissions
- `can_view_reports` : Voir les signalements
- `can_ban_users` : Bannir des utilisateurs
- `can_suspend_users` : Suspendre des utilisateurs
- `can_verify_users` : Vérifier des utilisateurs
- `can_delete_tweets` : Supprimer des tweets
- `can_view_analytics` : Voir les statistiques
- `can_manage_moderators` : Gérer les modérateurs

## 📊 Données de Test

Le script de migration crée automatiquement :
- 3 signalements de test (2 tweets, 1 utilisateur)
- 3 actions de modération de test (warn, suspend, delete)

## 🚨 Gestion des Erreurs

### Codes d'Erreur Communs
- `400` : Données invalides
- `401` : Non authentifié
- `403` : Permissions insuffisantes
- `404` : Ressource non trouvée
- `500` : Erreur serveur

### Logs
Toutes les actions sont loggées avec :
- Timestamp
- Utilisateur
- Action
- Cible
- Résultat

## 🔄 Workflow de Modération

### 1. Signalement
1. Utilisateur signale un contenu/utilisateur
2. Signalement créé avec statut "pending"
3. Attribution automatique de la priorité

### 2. Investigation
1. Modérateur examine le signalement
2. Statut changé à "investigating"
3. Ajout de notes de modération

### 3. Résolution
1. Action de modération appliquée
2. Statut changé à "resolved"
3. Enregistrement dans l'historique

### 4. Suivi
1. Actions actives surveillées
2. Expiration automatique des suspensions
3. Possibilité de révocation

## 🎯 Bonnes Pratiques

### Sécurité
- Validation stricte des entrées
- Vérification des permissions à chaque action
- Logs complets pour audit

### Performance
- Index sur les colonnes fréquemment utilisées
- Pagination pour les grandes listes
- Requêtes optimisées avec Sequelize

### Maintenance
- Nettoyage automatique des données expirées
- Sauvegarde régulière des tables critiques
- Monitoring des performances

## 🐛 Dépannage

### Problèmes Courants

#### 1. Tables non créées
```bash
# Vérifier la connexion à la base
node -e "require('./src/config/database').testConnection()"

# Relancer la migration
node migrate-moderation-tables.js
```

#### 2. Erreurs de permissions
```bash
# Vérifier le token
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/moderation/stats

# Vérifier le rôle utilisateur
SELECT role, moderation_permissions FROM users WHERE id = 'user_id';
```

#### 3. Données manquantes
```bash
# Vérifier les tables
SELECT COUNT(*) FROM reports;
SELECT COUNT(*) FROM moderation_actions;

# Recréer les données de test
node migrate-moderation-tables.js
```

## 📈 Évolutions Futures

### Fonctionnalités Prévues
- **Modération automatique** : IA pour détecter le contenu problématique
- **Notifications** : Alertes en temps réel pour les modérateurs
- **Rapports** : Export PDF/Excel des statistiques
- **API Webhook** : Intégration avec des services externes

### Optimisations
- **Cache Redis** : Mise en cache des statistiques fréquentes
- **Queue** : Traitement asynchrone des actions lourdes
- **CDN** : Distribution des médias modérés

## 📞 Support

Pour toute question ou problème :
1. Vérifier les logs de l'API
2. Consulter ce document
3. Tester avec les scripts fournis
4. Vérifier la base de données

---

**Version** : 1.0.0  
**Dernière mise à jour** : Août 2025  
**Auteur** : Équipe TwitNin
