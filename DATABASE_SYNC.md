# Synchronisation Automatique de la Base de Données

## Vue d'ensemble

L'API TwitNin est maintenant configurée pour créer automatiquement les tables de la base de données au démarrage si elles n'existent pas. Cette fonctionnalité utilise Sequelize pour gérer la synchronisation des modèles avec PostgreSQL.

## Fonctionnement

### Au démarrage du serveur

1. **Connexion à PostgreSQL** : Le serveur se connecte d'abord à la base de données
2. **Vérification des tables** : Le système vérifie si les tables nécessaires existent
3. **Création automatique** : Si les tables n'existent pas, elles sont créées automatiquement
4. **Synchronisation** : Si les tables existent, elles sont synchronisées avec les modèles

### Tables créées automatiquement

- **users** : Table principale des utilisateurs avec tous les champs définis dans le modèle User

## Configuration

### Variables d'environnement

Assurez-vous que votre fichier `.env` contient les bonnes informations de connexion :

```env
DB_HOST=51.255.48.125
DB_PORT=5432
DB_NAME=twitninf
DB_USER=admin
DB_PASSWORD=myytree88
```

### Modèles

Les modèles sont définis dans le dossier `src/models/` :
- `User.js` : Modèle utilisateur avec tous les champs et validations

## Scripts disponibles

### Test de synchronisation

```bash
npm run db:sync
```

Ce script teste :
- La connexion à PostgreSQL
- La synchronisation des tables
- L'affichage des tables créées

### Test de connexion

```bash
npm run db:test
```

Ce script teste uniquement la connexion à la base de données.

## Logs

La synchronisation génère des logs informatifs :

- `Tables non trouvées, création automatique...` : Quand les tables n'existent pas
- `Tables créées avec succès` : Quand les tables sont créées
- `Tables existantes détectées, synchronisation...` : Quand les tables existent déjà
- `Base de données synchronisée` : Quand la synchronisation est terminée

## Sécurité

- **Pas de suppression de données** : La synchronisation utilise `force: false` pour éviter de supprimer des données existantes
- **Vérification préalable** : Le système vérifie l'existence des tables avant de tenter la synchronisation
- **Gestion d'erreurs** : Les erreurs sont capturées et loggées proprement

## Développement

### Ajouter un nouveau modèle

1. Créez votre modèle dans `src/models/`
2. Ajoutez-le dans `src/models/index.js`
3. Redémarrez le serveur - la table sera créée automatiquement

### Exemple d'ajout de modèle

```javascript
// src/models/Post.js
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../database');

class Post extends Model {}

Post.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false
  }
}, {
  sequelize,
  modelName: 'Post',
  tableName: 'posts'
});

module.exports = Post;
```

Puis dans `src/models/index.js` :

```javascript
const Post = require('./Post');

const models = {
  User,
  Post
};
```

## Dépannage

### Erreur de connexion

Si vous obtenez une erreur de connexion :
1. Vérifiez les paramètres de connexion dans `src/config/config.js`
2. Assurez-vous que PostgreSQL est en cours d'exécution
3. Vérifiez les permissions de l'utilisateur de base de données

### Erreur de synchronisation

Si la synchronisation échoue :
1. Vérifiez les logs pour plus de détails
2. Assurez-vous que l'utilisateur a les permissions CREATE TABLE
3. Vérifiez la syntaxe de vos modèles

## Production

En production, il est recommandé de :
- Utiliser des migrations pour les changements de schéma
- Tester la synchronisation dans un environnement de staging
- Surveiller les logs de synchronisation
- Avoir une stratégie de sauvegarde avant les modifications de schéma
