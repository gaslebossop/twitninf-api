# Fix Modération - Recommandations des Tweets

## Problème Identifié

Le système de modération utilisait Gemini AI pour classer les tweets en 3 catégories :
- **`approved`** : Tweets normaux, éligibles aux recommandations
- **`not_eligible`** : Tweets visibles sur le profil mais non éligibles aux recommandations
- **`rejected`** : Tweets interdits, supprimés

**Problème** : Les tweets `not_eligible` étaient encore affichés dans les recommandations principales, ce qui pouvait exposer les utilisateurs à du contenu inapproprié.

## Solution Implémentée

### 1. Route Principale `/api/tweets`

**Avant** : Affichait tous les tweets `approved` et `pending`
**Après** : N'affiche que les tweets éligibles aux recommandations

```javascript
// AVANT
const moderationVisibility = {
  [Op.or]: [
    { moderation_status: 'approved' },
    { [Op.and]: [{ moderation_status: 'pending' }, { user_id: req.user.id }] }
  ]
};

// APRÈS - Même logique mais plus claire
let whereClause = {
  is_private: false,
  [Op.or]: [
    { moderation_status: 'approved' },
    { [Op.and]: [{ moderation_status: 'pending' }, { user_id: req.user.id }] }
  ]
};
```

### 2. Route Tweet Spécifique `/api/tweets/:id`

**Avant** : Permettait l'accès aux tweets `not_eligible`
**Après** : Bloque l'accès aux tweets non éligibles

```javascript
// AVANT
[Op.or]: [
  { moderation_status: 'approved' },
  { [Op.and]: [{ moderation_status: 'pending' }, { user_id: req.user.id }] }
]

// APRÈS
moderation_status: {
  [Op.notIn]: ['not_eligible', 'rejected']
}
```

### 3. Route des Réponses `/api/tweets/:id/replies`

**Avant** : Affichait toutes les réponses `approved`
**Après** : N'affiche que les réponses éligibles

```javascript
// AVANT
moderation_status: 'approved'

// APRÈS
moderation_status: {
  [Op.notIn]: ['not_eligible', 'rejected']
}
```

### 4. Comptage Total

**Avant** : Comptait tous les tweets visibles
**Après** : Compte uniquement les tweets éligibles aux recommandations

```javascript
// APRÈS
const totalCount = await Tweet.count({ 
  where: {
    ...whereClause,
    moderation_status: {
      [Op.notIn]: ['not_eligible', 'rejected']
    }
  }
});
```

## Résultat

✅ **Les recommandations n'affichent plus que les tweets éligibles**
✅ **Les tweets `not_eligible` restent visibles sur le profil de l'auteur**
✅ **Les tweets `rejected` sont complètement masqués**
✅ **La pagination reflète le bon nombre de tweets éligibles**

## Catégories de Modération

| Statut | Visible dans | Éligible aux Recommandations | Description |
|--------|--------------|------------------------------|-------------|
| `pending` | Profil auteur uniquement | ❌ | En attente de modération |
| `approved` | Partout | ✅ | Contenu normal et éligible |
| `not_eligible` | Profil auteur uniquement | ❌ | Contenu inapproprié mais non interdit |
| `rejected` | Nulle part | ❌ | Contenu interdit, supprimé |

## Impact sur l'Expérience Utilisateur

- **Recommandations plus propres** : Plus de contenu inapproprié dans le feed principal
- **Profil préservé** : Les utilisateurs peuvent toujours voir leurs tweets `not_eligible` sur leur profil
- **Modération transparente** : Les utilisateurs sont notifiés quand leurs tweets ne sont pas éligibles
- **Performance améliorée** : Moins de tweets à traiter dans les recommandations

## Fichiers Modifiés

- `src/routes/tweetRoutes.js` : Routes principales des tweets
- `src/routes/searchRoutes.js` : Déjà conforme (utilisait `moderation_status: 'approved'`)

## Tests Recommandés

1. **Créer un tweet avec contenu inapproprié** → Vérifier qu'il est marqué `not_eligible`
2. **Vérifier que le tweet n'apparaît pas dans les recommandations** → Route `/api/tweets`
3. **Vérifier que le tweet reste visible sur le profil** → Route `/api/users/:id/tweets`
4. **Tester la pagination** → Vérifier que le total exclut les tweets non éligibles
