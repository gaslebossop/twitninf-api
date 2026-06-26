const { Sequelize } = require('sequelize');
const config = require('../config/config');
const logger = require('../utils/logger');

// Configuration Sequelize avec les paramètres directs
const sequelize = new Sequelize(
  config.database.database,
  config.database.username,
  config.database.password,
  {
    host: config.database.host,
    port: config.database.port,
    dialect: config.database.dialect,
    logging: config.database.logging,
    benchmark: config.database.benchmark,
    define: config.database.define,
    dialectOptions: config.database.dialectOptions,
    pool: config.database.pool,
    retry: config.database.retry
  }
);

// Importer les modèles déjà initialisés depuis le nouveau système
const { 
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

// Test de connexion
async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.info('Connexion PostgreSQL établie avec succès');
    return true;
  } catch (error) {
    logger.error('Erreur de connexion PostgreSQL:', error);
    return false;
  }
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
