# 🚫 Guide du Système de Ban - API Twitninf

## **Vue d'ensemble**

Le système de ban de Twitninf utilise une approche **progressive et flexible** qui permet de gérer les violations sans supprimer les données des utilisateurs.

## **🎯 Principes clés**

- ✅ **Aucune suppression de données** - Les utilisateurs bannis gardent leur historique
- ✅ **Système progressif** - 5 violations = bannissement définitif
- ✅ **Suspensions temporaires** - Possibilité de rédemption
- ✅ **Blocage intelligent** - Différents niveaux selon le type d'action

## **🔒 Niveaux de restriction**

### **1. Utilisateur en avertissement (1-4 bans)**
- `is_active = true` ✅
- `ban_count = 1-4` ⚠️
- **Actions autorisées :** Lecture, navigation
- **Actions bloquées :** Création, modification, suppression

### **2. Utilisateur suspendu temporairement**
- `is_active = true` ✅
- `is_suspended = true` ⚠️
- `suspended_until = date_future` ⏰
- **Actions autorisées :** Lecture seule
- **Actions bloquées :** Toutes les actions d'écriture

### **3. Utilisateur banni définitivement (5+ bans)**
- `is_active = true` ✅
- `ban_count >= 5` 🚫
- `is_suspended = true` (permanent)
- **Actions autorisées :** Aucune
- **Actions bloquées :** Tout accès à l'API

## **🛡️ Middleware de protection**

### **`checkUserBanStrict`** - Blocage total
- **Utilisé pour :** Création, modification, suppression
- **Bloque :** Utilisateurs suspendus ET bannis définitivement
- **Routes :** POST tweets, likes, retweets, modifications de profil

### **`checkUserBanReadOnly`** - Blocage partiel
- **Utilisé pour :** Routes de lecture
- **Bloque :** Seulement les bannis définitifs
- **Permet :** Accès en lecture aux utilisateurs suspendus

## **📋 Routes d'administration des bans**

### **Suspendre un utilisateur**
```http
POST /api/users/:id/suspend
{
  "reason": "Violation des conditions d'utilisation",
  "duration_days": 7
}
```

### **Lever une suspension**
```http
POST /api/users/:id/unsuspend
```

### **Ajouter un ban**
```http
POST /api/users/:id/ban
{
  "reason": "Contenu inapproprié"
}
```

### **Réduire un ban (grâce)**
```http
POST /api/users/:id/unban
```

### **Consulter l'historique des bans**
```http
GET /api/users/:id/ban-history
```

## **⚙️ Configuration automatique**

### **Nettoyage des suspensions expirées**
- **Fréquence :** Toutes les heures
- **Action :** Réactivation automatique des comptes
- **Log :** Traçabilité complète des actions

### **Gestion des suspensions permanentes**
- **Déclencheur :** 5ème violation
- **Action :** Suspension automatique sans date d'expiration
- **Réversibilité :** Possible via réduction du ban count

## **📊 Métadonnées de suivi**

Chaque action de ban/suspension est tracée avec :
```json
{
  "admin_id": "uuid_admin",
  "duration_days": 7,
  "previous_ban_count": 2,
  "last_ban_reason": "Spam",
  "last_ban_date": "2024-01-15T10:30:00Z",
  "permanent_ban": false,
  "ban_reduced_by": null,
  "ban_reduced_at": null
}
```

## **🔍 Vérification du statut**

### **Statuts possibles :**
- `CLEAN` - Aucun ban
- `WARNED` - 1-4 bans (avertissements)
- `SUSPENDED` - Temporairement suspendu
- `SUSPENSION_EXPIRED` - Suspension expirée
- `PERMANENTLY_BANNED` - 5+ bans (définitif)

## **🚨 Gestion des erreurs**

### **Réponses d'erreur typiques :**
```json
{
  "success": false,
  "message": "Votre compte est temporairement suspendu",
  "ban_info": {
    "reason": "Violation des conditions d'utilisation",
    "suspended_at": "2024-01-15T10:30:00Z",
    "suspended_until": "2024-01-22T10:30:00Z",
    "remaining_days": 5,
    "ban_count": 3
  }
}
```

## **💡 Bonnes pratiques**

### **Pour les administrateurs :**
1. **Toujours justifier** les bans avec des raisons claires
2. **Utiliser les suspensions temporaires** avant les bans définitifs
3. **Surveiller les patterns** de violation
4. **Documenter** les décisions importantes

### **Pour les développeurs :**
1. **Tester** tous les niveaux de restriction
2. **Logger** toutes les actions de ban
3. **Respecter** la hiérarchie des middlewares
4. **Gérer gracieusement** les erreurs de ban

## **🔧 Maintenance**

### **Tâches automatiques :**
- Nettoyage des suspensions expirées
- Mise à jour des statistiques de ban
- Archivage des anciens logs

### **Tâches manuelles :**
- Révision des bans anciens
- Analyse des patterns de violation
- Ajustement des seuils si nécessaire

---

**⚠️ Important :** Ce système garantit qu'aucune donnée utilisateur n'est perdue, même en cas de bannissement définitif. Les données restent disponibles pour la modération et l'analyse.
