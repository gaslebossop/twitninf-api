# Documentation des Routes API TwitNin

## 🔗 Base URL
```
http://localhost:3000/api
```

## 📋 Routes d'Authentification

### 🔓 Routes Publiques

#### POST `/auth/register`
**Inscription d'un nouvel utilisateur**

**Body:**
```json
{
  "username": "john_doe",
  "fullName": "John Doe",
  "email": "john@example.com",
  "phone": "+33123456789",
  "password": "SecurePass123!",
  "platform": "mobile"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Compte créé avec succès",
  "data": {
    "user": {
      "id": "uuid",
      "username": "john_doe",
      "full_name": "John Doe",
      "email": "john@example.com",
      "verified": false,
      "premium": false,
      "avatar": "https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U",
      "stats": {
        "followers": 0,
        "following": 0,
        "tweets": 0,
        "likes": 0
      },
      "created_at": "2024-01-01T00:00:00.000Z"
    },
    "token": "jwt_token",
    "refreshToken": "refresh_token"
  }
}
```

#### POST `/auth/login`
**Connexion utilisateur**

**Body:**
```json
{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Connexion réussie",
  "data": {
    "user": {
      "id": "uuid",
      "username": "john_doe",
      "full_name": "John Doe",
      "email": "john@example.com",
      "verified": false,
      "premium": false,
      "avatar": "https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U",
      "stats": {
        "followers": 0,
        "following": 0,
        "tweets": 0,
        "likes": 0
      },
      "last_activity": "2024-01-01T00:00:00.000Z"
    },
    "token": "jwt_token",
    "refreshToken": "refresh_token"
  }
}
```

#### POST `/auth/refresh`
**Rafraîchir le token d'authentification**

**Body:**
```json
{
  "refreshToken": "refresh_token"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Token rafraîchi avec succès",
  "data": {
    "token": "new_jwt_token",
    "refreshToken": "new_refresh_token"
  }
}
```

#### POST `/auth/forgot-password`
**Demander la réinitialisation du mot de passe**

**Body:**
```json
{
  "email": "john@example.com"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Si l'email existe, un lien de réinitialisation a été envoyé"
}
```

#### POST `/auth/reset-password/:token`
**Réinitialiser le mot de passe**

**Body:**
```json
{
  "password": "NewSecurePass123!"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Mot de passe réinitialisé avec succès"
}
```

#### GET `/auth/verify-email/:token`
**Vérifier l'email**

**Réponse:**
```json
{
  "success": true,
  "message": "Email vérifié avec succès"
}
```

### 🔒 Routes Protégées

*Toutes les routes suivantes nécessitent un token d'authentification dans le header:*
```
Authorization: Bearer <jwt_token>
```

#### POST `/auth/logout`
**Déconnexion utilisateur**

**Réponse:**
```json
{
  "success": true,
  "message": "Déconnexion réussie"
}
```

#### GET `/auth/me`
**Récupérer le profil de l'utilisateur connecté**

**Réponse:**
```json
{
  "success": true,
  "message": "Profil récupéré avec succès",
  "data": {
    "id": "uuid",
    "username": "john_doe",
    "full_name": "John Doe",
    "email": "john@example.com",
    "phone": "+33123456789",
    "verified": false,
    "premium": false,
    "platform": "mobile",
    "avatar": "https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U",
    "stats": {
      "followers": 0,
      "following": 0,
      "tweets": 0,
      "likes": 0
    },
    "preferences": {
      "language": "fr",
      "theme": "dark",
      "notifications": {
        "push": true,
        "email": true,
        "sms": false
      }
    },
    "created_at": "2024-01-01T00:00:00.000Z",
    "last_activity": "2024-01-01T00:00:00.000Z"
  }
}
```

#### GET `/auth/profile`
**Alias pour `/auth/me`**

#### PUT `/auth/profile`
**Mettre à jour le profil utilisateur**

**Body:**
```json
{
  "full_name": "John Doe Updated",
  "avatar": "https://example.com/new-avatar.jpg",
  "preferences": {
    "language": "en",
    "theme": "light",
    "notifications": {
      "push": false,
      "email": true,
      "sms": true
    }
  }
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Profil mis à jour avec succès",
  "data": {
    "id": "uuid",
    "username": "john_doe",
    "full_name": "John Doe Updated",
    "email": "john@example.com",
    "verified": false,
    "premium": false,
    "platform": "mobile",
    "avatar": "https://example.com/new-avatar.jpg",
    "stats": {
      "followers": 0,
      "following": 0,
      "tweets": 0,
      "likes": 0
    },
    "preferences": {
      "language": "en",
      "theme": "light",
      "notifications": {
        "push": false,
        "email": true,
        "sms": true
      }
    },
    "created_at": "2024-01-01T00:00:00.000Z",
    "last_activity": "2024-01-01T00:00:00.000Z"
  }
}
```

#### PUT `/auth/change-password`
**Changer le mot de passe**

**Body:**
```json
{
  "currentPassword": "OldSecurePass123!",
  "newPassword": "NewSecurePass123!"
}
```

**Réponse:**
```json
{
  "success": true,
  "message": "Mot de passe changé avec succès"
}
```

#### GET `/auth/verify-auth`
**Vérifier l'authentification**

**Réponse:**
```json
{
  "success": true,
  "message": "Profil récupéré avec succès",
  "data": {
    "id": "uuid",
    "username": "john_doe",
    "full_name": "John Doe",
    "email": "john@example.com",
    "verified": false,
    "premium": false,
    "platform": "mobile",
    "avatar": "https://via.placeholder.com/150x150/4A90E2/FFFFFF?text=U",
    "stats": {
      "followers": 0,
      "following": 0,
      "tweets": 0,
      "likes": 0
    },
    "preferences": {
      "language": "fr",
      "theme": "dark",
      "notifications": {
        "push": true,
        "email": true,
        "sms": false
      }
    },
    "created_at": "2024-01-01T00:00:00.000Z",
    "last_activity": "2024-01-01T00:00:00.000Z"
  }
}
```

### 📊 Routes Utilitaires

#### GET `/auth/stats`
**Statistiques de l'utilisateur**

**Réponse:**
```json
{
  "success": true,
  "stats": {
    "accountAge": 30,
    "activityStatus": "online",
    "lastActivity": "2024-01-01T00:00:00.000Z"
  }
}
```

#### GET `/auth/search`
**Rechercher des utilisateurs**

**Query Parameters:**
- `query` (string, requis): Terme de recherche
- `limit` (number, optionnel): Nombre de résultats (défaut: 10)

**Exemple:**
```
GET /auth/search?query=john&limit=5
```

**Réponse:**
```json
{
  "success": true,
  "message": "Recherche d'utilisateur",
  "query": "john",
  "limit": 5
}
```

#### GET `/auth/popular`
**Utilisateurs populaires**

**Query Parameters:**
- `limit` (number, optionnel): Nombre de résultats (défaut: 10)

**Exemple:**
```
GET /auth/popular?limit=5
```

**Réponse:**
```json
{
  "success": true,
  "message": "Utilisateurs populaires",
  "limit": 5
}
```

#### GET `/auth/performance-test`
**Test de performance**

**Réponse:**
```json
{
  "success": true,
  "message": "Test de performance réussi",
  "duration": "15.23ms",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "user": {
    "id": "uuid",
    "username": "john_doe"
  }
}
```

### ⭐ Routes Premium

#### GET `/auth/premium-features`
**Fonctionnalités premium** (nécessite un compte premium)

**Réponse:**
```json
{
  "success": true,
  "message": "Fonctionnalités premium accessibles",
  "features": [
    "Analytics avancées",
    "Support prioritaire",
    "Fonctionnalités exclusives"
  ]
}
```

#### GET `/auth/verified-features`
**Fonctionnalités vérifiées** (nécessite un compte vérifié)

**Réponse:**
```json
{
  "success": true,
  "message": "Fonctionnalités vérifiées accessibles",
  "features": [
    "Publication de contenu",
    "Commentaires",
    "Messages privés"
  ]
}
```

## 🏥 Route de Santé

#### GET `/health`
**Vérifier l'état de l'API**

**Réponse:**
```json
{
  "success": true,
  "message": "API twitninf opérationnelle",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "environment": "development",
  "database": "connected",
  "redis": "connected",
  "memory": {
    "rss": 12345678,
    "heapTotal": 9876543,
    "heapUsed": 5432109,
    "external": 123456
  },
  "version": "1.0.0"
}
```

## 🚫 Gestion des Erreurs

### Format d'Erreur Standard
```json
{
  "success": false,
  "message": "Description de l'erreur",
  "errors": [
    {
      "field": "username",
      "message": "Le nom d'utilisateur doit contenir entre 3 et 30 caractères"
    }
  ]
}
```

### Codes d'Erreur HTTP
- `400` - Données invalides
- `401` - Non authentifié
- `403` - Accès interdit
- `404` - Route non trouvée
- `409` - Conflit (ex: nom d'utilisateur déjà pris)
- `500` - Erreur serveur interne

## 🔧 Headers Requis

### Pour toutes les requêtes
```
Content-Type: application/json
User-Platform: mobile
```

### Pour les routes protégées
```
Authorization: Bearer <jwt_token>
```

## 📝 Validation des Données

### Règles de Validation
- **username**: 3-30 caractères, lettres, chiffres et underscores uniquement
- **email**: Format email valide
- **phone**: Format international (+33123456789)
- **password**: Minimum 8 caractères, majuscule, minuscule, chiffre et caractère spécial
- **fullName**: 2-100 caractères

### Exemple d'Erreur de Validation
```json
{
  "success": false,
  "message": "Données invalides",
  "errors": [
    {
      "type": "field",
      "value": "a",
      "msg": "Le nom d'utilisateur doit contenir entre 3 et 30 caractères et ne peut contenir que des lettres, chiffres et underscores",
      "path": "username",
      "location": "body"
    }
  ]
}
```

## 🧪 Tests

### Lancer les tests de routes
```bash
npm run test:routes
```

### Tester une route spécifique
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -H "User-Platform: mobile" \
  -d '{
    "username": "testuser",
    "fullName": "Test User",
    "email": "test@example.com",
    "phone": "+33123456789",
    "password": "TestPass123!",
    "platform": "mobile"
  }'
```

## 📚 Exemples d'Utilisation

### Inscription et Connexion
```javascript
// 1. Inscription
const registerResponse = await fetch('/api/auth/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Platform': 'mobile'
  },
  body: JSON.stringify({
    username: 'john_doe',
    fullName: 'John Doe',
    email: 'john@example.com',
    phone: '+33123456789',
    password: 'SecurePass123!',
    platform: 'mobile'
  })
});

const { data: { token, refreshToken } } = await registerResponse.json();

// 2. Connexion
const loginResponse = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Platform': 'mobile'
  },
  body: JSON.stringify({
    email: 'john@example.com',
    password: 'SecurePass123!'
  })
});

// 3. Récupérer le profil
const profileResponse = await fetch('/api/auth/me', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'User-Platform': 'mobile'
  }
});
```

## 🔄 Refresh Token

### Utilisation automatique
```javascript
// Intercepteur Axios pour refresh automatique
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const refreshResponse = await axios.post('/api/auth/refresh', {
        refreshToken: localStorage.getItem('refreshToken')
      });
      
      const { token, refreshToken } = refreshResponse.data.data;
      localStorage.setItem('token', token);
      localStorage.setItem('refreshToken', refreshToken);
      
      // Retry la requête originale
      error.config.headers.Authorization = `Bearer ${token}`;
      return axios(error.config);
    }
    return Promise.reject(error);
  }
);
```
