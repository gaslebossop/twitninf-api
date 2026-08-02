const config = require('../config/config');
const logger = require('../utils/logger');

// Ce fichier créait auparavant sa PROPRE instance Sequelize (`new Sequelize(...)`),
// distincte de celle initialisée dans `../models` avec tous les modèles et
// associations. Résultat concret : un second pool de connexions Postgres
// (jusqu'à `pool.max` connexions supplémentaires, doublant l'empreinte réelle
// du process pour zéro bénéfice) sur lequel AUCUN modèle n'était enregistré —
// `sequelize.models` y restait vide. Le cron de nettoyage des notifications
// dans server.js (`sequelize.models.Notification.destroy(...)`) plantait donc
// silencieusement chaque nuit (catch muet), et les ~30 fichiers économie/
// wallet/casino qui font `require('../database').sequelize` pour ouvrir une
// transaction, puis passent cette transaction à des modèles de `../models`
// (donc une AUTRE instance), s'appuyaient sur un couplage fragile entre deux
// pools distincts. Réutiliser l'unique instance déjà initialisée par
// `../models` élimine le doublon de pool et les deux effets de bord ci-dessus,
// sans changer l'interface exportée par ce fichier.
const {
  sequelize,
  User,
  Tweet,
  TweetLike,
  TweetRetweet,
  Notification,
  UserFollow,
  testConnection: testModelsConnection,
  syncDatabase: syncModelsDatabase,
  closeConnection: closeModelsConnection
} = require('../models');

// Test de connexion (délègue à la même instance ; conservé pour compatibilité
// des appelants qui font `require('./database').testConnection()`).
async function testConnection() {
  return testModelsConnection();
}

// Synchronisation des modèles avec création automatique des tables
async function syncDatabase(force = false) {
  try {
    logger.info('Début de la synchronisation de la base de données...');
    
    // Utiliser la fonction de synchronisation des modèles
    await syncModelsDatabase(force);
    
    // Vérifier que la table users existe
    const tables = await sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    if (tables.length > 0) {
      logger.info('Table users confirmée');
    } else {
      logger.warn('Table users non trouvée après synchronisation');
    }
  } catch (error) {
    logger.error('Erreur de synchronisation:', error);
    throw error;
  }
}

// Fermeture de la connexion
async function closeConnection() {
  try {
    await closeModelsConnection();
    logger.info('Connexion PostgreSQL fermée');
  } catch (error) {
    logger.error('Erreur lors de la fermeture de la connexion:', error);
  }
}

// Gestionnaire d'événements
sequelize.addHook('beforeConnect', async (config) => {
  logger.debug('Tentative de connexion PostgreSQL...');
});

sequelize.addHook('afterConnect', async (connection) => {
  logger.debug('Nouvelle connexion PostgreSQL établie');
});

// Middleware pour les requêtes lentes
if (config.server.env === 'development') {
  sequelize.addHook('beforeQuery', (options) => {
    options.benchmark = true;
  });

  sequelize.addHook('afterQuery', (options, { sql, duration }) => {
    if (duration > 1000) {
      logger.warn(`Requête lente détectée (${duration}ms):`, sql);
    }
  });
}

module.exports = {
  sequelize,
  User,
  Tweet,
  TweetLike,
  TweetRetweet,
  Notification,
  UserFollow,
  testConnection,
  syncDatabase,
  closeConnection
};
