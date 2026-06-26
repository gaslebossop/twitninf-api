# API de Monétisation - Documentation Complète

## 🎯 Vue d'ensemble

L'API de monétisation permet de gérer les revenus des utilisateurs basés sur les performances de leurs tweets. Elle calcule automatiquement le RPM (Revenue Per Mille) et gère l'éligibilité des tweets à la monétisation.

## 📊 Modèle de données

### Table `monetization_metrics`

```sql
CREATE TABLE monetization_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  views INTEGER DEFAULT 0,
  eligible_clicks INTEGER DEFAULT 0,
  revenue DECIMAL(10,2) DEFAULT 0.00,
  rpm DECIMAL(10,4) DEFAULT 0.0000,
  is_eligible BOOLEAN DEFAULT false,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Index de performance
- `tweet_id` - Recherche rapide par tweet
- `is_eligible` - Filtrage des tweets éligibles
- `last_updated` - Tri par date de mise à jour

## 🚀 Routes API

### 1. Obtenir les tweets éligibles
```http
GET /api/monetization/eligible-tweets
```

**Paramètres de requête :**
- `limit` (int, défaut: 20) - Nombre de tweets à retourner
- `offset` (int, défaut: 0) - Pagination
- `minViews` (int, défaut: 1000) - Nombre minimum de vues
- `minEngagement` (float, défaut: 0.01) - Taux d'engagement minimum

**Réponse :**
```json
{
  "success": true,
  "data": {
    "tweets": [
      {
        "id": 123,
        "content": "Contenu du tweet...",
        "created_at": "2024-01-01T00:00:00Z",
        "author": {
          "id": 1,
          "username": "user",
          "full_name": "Nom Complet",
          "avatar": "avatar.jpg",
          "verified": true,
          "premium": false
        },
        "stats": {
          "likes": 1500,
          "retweets": 200,
          "replies": 50,
          "views": 25000
        },
        "monetization": {
          "rpm": 15.50,
          "eligibleClicks": 125,
          "revenue": 62.50,
          "isEligible": true
        }
      }
    ],
    "total": 1,
    "pagination": {
      "limit": 20,
      "offset": 0
    }
  }
}
```

### 2. Obtenir les revenus utilisateur
```http
GET /api/monetization/revenue
```

**Paramètres de requête :**
- `period` (string, défaut: "month") - Période : "day", "week", "month", "year"

**Réponse :**
```json
{
  "success": true,
  "data": {
    "totalRevenue": 1250.75,
    "totalViews": 150000,
    "totalClicks": 2500,
    "averageRPM": 8.34,
    "period": "month",
    "metricsCount": 45
  }
}
```

### 3. Obtenir les statistiques globales
```http
GET /api/monetization/stats
```

**Réponse :**
```json
{
  "success": true,
  "data": {
    "monthlyRevenue": 1250.75,
    "totalTweets": 150,
    "eligibleTweets": 45,
    "averageRPM": 8.34,
    "totalViews": 150000,
    "totalClicks": 2500
  }
}
```

### 4. Mettre à jour les métriques d'un tweet
```http
PUT /api/monetization/tweets/:tweetId/metrics
```

**Corps de la requête :**
```json
{
  "views": 15000,
  "clicks": 750,
  "revenue": 375.50
}
```

**Réponse :**
```json
{
  "success": true,
  "data": {
    "tweetId": 123,
    "metrics": {
      "rpm": 25.03,
      "eligibleClicks": 750,
      "revenue": 375.50,
      "isEligible": true
    }
  }
}
```

### 5. Simuler l'engagement (tests)
```http
POST /api/monetization/tweets/:tweetId/simulate
```

**Réponse :**
```json
{
  "success": true,
  "data": {
    "tweetId": 123,
    "metrics": {
      "rpm": 12.50,
      "eligibleClicks": 125,
      "revenue": 62.50,
      "isEligible": true
    }
  }
}
```

## 🧮 Calcul du RPM

Le RPM (Revenue Per Mille) est calculé selon la formule :

```
RPM = (Revenue / Views) × 1000
```

**Exemple :**
- Revenue : 50€
- Views : 10,000
- RPM = (50 / 10,000) × 1000 = 5.00

## ✅ Critères d'éligibilité

Un tweet est considéré comme éligible à la monétisation si :

1. **Vues minimum** : ≥ 1,000 vues
2. **Taux d'engagement** : ≥ 1% (likes/views)
3. **Statut de modération** : "approved"
4. **Tweet public** : `is_private = false`
5. **Tweet non supprimé** : `deleted_at = null`

## 🔧 Fonctionnalités avancées

### Simulation d'engagement
Pour les tests, l'API peut simuler automatiquement :
- **Taux de clic** : 0-5% basé sur les vues
- **CPC moyen** : 0.30-0.70€ par clic
- **Calcul automatique** du RPM

### Pagination intelligente
- Support de `limit` et `offset`
- Optimisation des requêtes avec index
- Cache Redis pour les métriques fréquentes

### Sécurité
- **Authentification** requise sur toutes les routes
- **Vérification de propriété** des tweets
- **Rate limiting** pour éviter l'abus
- **Validation** des données d'entrée

## 📈 Performance

### Optimisations
- **Index sur les colonnes clés**
- **Requêtes optimisées** avec JOIN
- **Cache Redis** pour les métriques
- **Pagination** pour éviter les requêtes lourdes

### Métriques de performance
- **Temps de réponse** : < 100ms pour les requêtes simples
- **Throughput** : 1000+ requêtes/minute
- **Concurrence** : Support de 100+ utilisateurs simultanés

## 🚀 Déploiement

### Migration de base de données
```bash
# Exécuter la migration
node src/scripts/monetizationMigration.js
```

### Test de l'API
```bash
# Tester toutes les routes
node test-monetization-api.js
```

### Variables d'environnement
```env
# Configuration de la monétisation
MONETIZATION_MIN_VIEWS=1000
MONETIZATION_MIN_ENGAGEMENT=0.01
MONETIZATION_CPC_MIN=0.30
MONETIZATION_CPC_MAX=0.70
```

## 🔮 Fonctionnalités futures

### Planifiées
- [ ] **Paiements automatiques** via Stripe/PayPal
- [ ] **Notifications** de nouveaux revenus
- [ ] **Export CSV** des données de revenus
- [ ] **Graphiques** de performance
- [ ] **Alertes** de seuils de revenus

### Améliorations
- [ ] **Machine Learning** pour prédire le RPM
- [ ] **A/B Testing** des stratégies de monétisation
- [ ] **Intégration** avec les réseaux publicitaires
- [ ] **Analytics avancés** avec Google Analytics

---

*API de monétisation développée pour TwitNin Legacy*

