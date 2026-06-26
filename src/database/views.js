const { sequelize } = require('./index');
const logger = require('../utils/logger');

// Configuration des vues de base de données
const VIEWS_CONFIG = {
  popular_users: `
    CREATE OR REPLACE VIEW popular_users AS
    SELECT 
      id, username, full_name, avatar, verified, premium,
      stats->>'followers' as followers_count,
      stats->>'following' as following_count,
      stats->>'tweets' as tweets_count,
      created_at, last_activity
    FROM users 
    WHERE is_active = true 
    ORDER BY (stats->>'followers')::integer DESC
  `,
  
  recent_users: `
    CREATE OR REPLACE VIEW recent_users AS
    SELECT 
      id, username, full_name, avatar, verified, premium,
      created_at, last_activity
    FROM users 
    WHERE is_active = true 
    AND created_at >= NOW() - INTERVAL '30 days'
    ORDER BY created_at DESC
  `,
  
  global_stats: `
    CREATE OR REPLACE VIEW global_stats AS
    SELECT 
      COUNT(*) as total_users,
      COUNT(*) FILTER (WHERE verified = true) as verified_users,
      COUNT(*) FILTER (WHERE premium = true) as premium_users,
      COUNT(*) FILTER (WHERE last_activity >= NOW() - INTERVAL '24 hours') as active_today,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_this_week,
      AVG((stats->>'followers')::integer) as avg_followers,
      AVG((stats->>'tweets')::integer) as avg_tweets
    FROM users 
    WHERE is_active = true
  `
};

// Fonction pour supprimer toutes les vues
async function dropAllViews() {
  try {
    logger.info('Suppression des vues dépendantes...');
    
    const viewsToDrop = [
      'popular_users',
      'recent_users', 
      'global_stats'
    ];
    
    for (const viewName of viewsToDrop) {
      try {
        await sequelize.query(`DROP VIEW IF EXISTS ${viewName} CASCADE`);
        logger.debug(`Vue ${viewName} supprimée`);
      } catch (error) {
        logger.warn(`Erreur lors de la suppression de la vue ${viewName}:`, error.message);
      }
    }
    
    logger.info('Toutes les vues ont été supprimées');
    return true;
  } catch (error) {
    logger.error('Erreur lors de la suppression des vues:', error);
    return false;
  }
}

// Fonction pour créer toutes les vues
async function createAllViews() {
  try {
    logger.info('Création des vues optimisées...');
    
    for (const [viewName, viewQuery] of Object.entries(VIEWS_CONFIG)) {
      try {
        await sequelize.query(viewQuery);
        logger.debug(`Vue ${viewName} créée avec succès`);
      } catch (error) {
        logger.error(`Erreur lors de la création de la vue ${viewName}:`, error);
        throw error;
      }
    }
    
    logger.info('Toutes les vues ont été créées avec succès');
    return true;
  } catch (error) {
    logger.error('Erreur lors de la création des vues:', error);
    return false;
  }
}

// Fonction pour vérifier l'état des vues
async function checkViewsStatus() {
  try {
    const views = await sequelize.query(`
      SELECT viewname, definition 
      FROM pg_views 
      WHERE schemaname = 'public' 
      AND viewname IN ('popular_users', 'recent_users', 'global_stats')
    `, { type: sequelize.QueryTypes.SELECT });
    
    logger.info(`État des vues: ${views.length} vues trouvées`);
    views.forEach(view => {
      logger.debug(`Vue ${view.viewname} existe`);
    });
    
    return views;
  } catch (error) {
    logger.error('Erreur lors de la vérification des vues:', error);
    return [];
  }
}

// Fonction pour recréer une vue spécifique
async function recreateView(viewName) {
  try {
    if (!VIEWS_CONFIG[viewName]) {
      throw new Error(`Vue ${viewName} non configurée`);
    }
    
    // Supprimer la vue existante
    await sequelize.query(`DROP VIEW IF EXISTS ${viewName} CASCADE`);
    
    // Recréer la vue
    await sequelize.query(VIEWS_CONFIG[viewName]);
    
    logger.info(`Vue ${viewName} recréée avec succès`);
    return true;
  } catch (error) {
    logger.error(`Erreur lors de la recréation de la vue ${viewName}:`, error);
    return false;
  }
}

module.exports = {
  dropAllViews,
  createAllViews,
  checkViewsStatus,
  recreateView,
  VIEWS_CONFIG
};
