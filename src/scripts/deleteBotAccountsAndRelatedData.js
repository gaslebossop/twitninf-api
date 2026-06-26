const logger = require('../utils/logger');
const { sequelize, closeConnection } = require('../models');

async function deleteBotAccountsAndRelatedData() {
  const prefix = (process.env.BOT_PREFIX || 'bot_account_').trim();
  const likePattern = `${prefix}%`;

  try {
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    // Charger les ids (une seule fois)
    const [rows] = await sequelize.query(
      `SELECT id FROM users WHERE username LIKE :likePattern`,
      { replacements: { likePattern } }
    );
    const ids = rows.map((r) => r.id);

    if (!ids.length) {
      console.log(`ℹ️ Aucun bot trouvé avec username LIKE "${likePattern}"`);
      return;
    }

    console.log(`🧹 Bots trouvés: ${ids.length}. Suppression en cours...`);

    // Chunk pour éviter les requêtes trop grosses
    const chunkSize = Number.parseInt(process.env.CHUNK_SIZE || '2000', 10);
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

    // Ordre: tables dépendantes -> users
    // (si certaines tables n'existent pas dans ton schéma, la requête échouera : on les garde minimales et présentes dans ce repo)
    for (const c of chunks) {
      // Transactions courtes par chunk (évite de tout abort si une seule query échoue)
      await sequelize.transaction(async (t) => {
        // user_follows
        await sequelize.query(
          `DELETE FROM user_follows WHERE follower_id IN (:ids) OR following_id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );

        // notifications (les premiers runs avec hooks pouvaient en créer)
        await sequelize.query(
          `DELETE FROM notifications WHERE sender_id IN (:ids) OR recipient_id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );

        // tweets + interactions (au cas où)
        await sequelize.query(
          `DELETE FROM tweet_likes WHERE user_id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );
        await sequelize.query(
          `DELETE FROM tweet_retweets WHERE user_id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );
        await sequelize.query(
          `DELETE FROM tweets WHERE user_id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );

        // enfin users
        await sequelize.query(
          `DELETE FROM users WHERE id IN (:ids)`,
          { transaction: t, replacements: { ids: c } }
        );
      });
    }

    console.log(`✅ Suppression terminée: ${ids.length} bots supprimés.`);
  } catch (error) {
    logger.error('Erreur script deleteBotAccountsAndRelatedData:', error);
    console.error('❌ Erreur:', error.message);
    process.exitCode = 1;
  } finally {
    try {
      if (closeConnection) await closeConnection();
      else await sequelize.close();
    } catch (e) {
      // ignore
    }
  }
}

if (require.main === module) {
  deleteBotAccountsAndRelatedData();
}

module.exports = deleteBotAccountsAndRelatedData;

