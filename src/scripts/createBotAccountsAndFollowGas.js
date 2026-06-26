const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sequelize, User, UserFollow, closeConnection } = require('../models');

function makePassword() {
  // Respecte la contrainte len >= 7 du modèle User
  return `Bot#${crypto.randomBytes(6).toString('hex')}`;
}

async function createBotAccountsAndFollowGas() {
  const targetUsername = 'gas';
  const botCount = Number.parseInt(process.env.BOT_COUNT || '1500', 10);
  const chunkSize = Number.parseInt(process.env.CHUNK_SIZE || '1000', 10);
  const botPrefix = 'bot_account_';

  try {
    // Evite les timeouts d'acquisition de connexion sur de gros batches
    if (sequelize?.options?.pool) {
      sequelize.options.pool.acquire = Math.max(sequelize.options.pool.acquire || 0, 120000);
    }
    // Evite les retries courts qui finissent en "unknown timed out"
    if (sequelize?.options) {
      sequelize.options.retry = { max: 0 };
      if (sequelize.options.dialectOptions) {
        sequelize.options.dialectOptions.statement_timeout = Math.max(sequelize.options.dialectOptions.statement_timeout || 0, 300000);
      }
    }
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    const gasUser = await User.findOne({ where: { username: targetUsername } });
    if (!gasUser) {
      throw new Error(`Utilisateur cible introuvable: @${targetUsername}`);
    }

    if (!Number.isFinite(botCount) || botCount <= 0) {
      throw new Error(`BOT_COUNT invalide: ${process.env.BOT_COUNT}`);
    }
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      throw new Error(`CHUNK_SIZE invalide: ${process.env.CHUNK_SIZE}`);
    }

    let createdCount = 0;
    let totalNewFollows = 0;
    let totalExistingFollows = 0;
    let sharedPlainPassword = null;
    let sharedHashedPassword = null;

    const baseRowsTemplate = {
      email: null,
      platform: 'web',
      verified: false,
      premium: false,
      role: 'user',
      stats: { followers: 0, following: 0, tweets: 0, likes: 0 },
      preferences: {
        language: 'fr',
        theme: 'dark',
        notifications: { push: false, email: false, sms: false }
      }
    };

    for (let start = 1; start <= botCount; start += chunkSize) {
      const end = Math.min(botCount, start + chunkSize - 1);
      const usernamesChunk = [];
      for (let i = start; i <= end; i++) usernamesChunk.push(`${botPrefix}${i}`);

      // Charger existants du chunk
      const existingChunk = await User.findAll({
        where: { username: { [Op.in]: usernamesChunk } },
        attributes: ['id', 'username']
      });
      const existingSet = new Set(existingChunk.map(u => u.username));

      // Créer manquants du chunk
      const missing = usernamesChunk.filter(u => !existingSet.has(u));
      if (missing.length) {
        if (!sharedPlainPassword) {
          sharedPlainPassword = makePassword();
          sharedHashedPassword = await bcrypt.hash(sharedPlainPassword, 12);
        }

        const rows = missing.map((username) => {
          const n = Number(username.slice(botPrefix.length));
          return {
            ...baseRowsTemplate,
            username,
            full_name: `Bot Account ${n}`,
            password: sharedHashedPassword
          };
        });

        await User.bulkCreate(rows, {
          hooks: false,
          validate: true,
          ignoreDuplicates: true
        });

        createdCount += rows.length;
      }

      // Recharger ids du chunk
      const botsChunk = await User.findAll({
        where: { username: { [Op.in]: usernamesChunk } },
        attributes: ['id', 'username']
      });
      const botIdsChunk = botsChunk.map(b => b.id);
      if (botIdsChunk.length === 0) continue;

      // Follows existants chunk -> gas
      const existingFollowsChunk = await UserFollow.findAll({
        where: {
          following_id: gasUser.id,
          follower_id: { [Op.in]: botIdsChunk }
        },
        attributes: ['follower_id']
      });
      totalExistingFollows += existingFollowsChunk.length;
      const already = new Set(existingFollowsChunk.map(f => f.follower_id));

      const newFollowRows = botsChunk
        .filter(b => !already.has(b.id))
        .map(b => ({
          follower_id: b.id,
          following_id: gasUser.id,
          status: 'active',
          metadata: { source: 'script', device: 'server', ip_address: null }
        }));

      if (!newFollowRows.length) continue;

      await UserFollow.bulkCreate(newFollowRows, {
        hooks: false,
        validate: true,
        ignoreDuplicates: true
      });

      totalNewFollows += newFollowRows.length;

      // Update stats (chunk)
      const newFollowerIds = newFollowRows.map(r => r.follower_id);
      await sequelize.transaction(async (t) => {
        await sequelize.query(
          `
          UPDATE users
          SET stats = jsonb_set(
            COALESCE(stats, '{}'::jsonb),
            '{following}',
            to_jsonb(COALESCE((stats->>'following')::int, 0) + 1),
            true
          )
          WHERE id IN (:ids)
          `,
          { transaction: t, replacements: { ids: newFollowerIds } }
        );

        await sequelize.query(
          `
          UPDATE users
          SET stats = jsonb_set(
            COALESCE(stats, '{}'::jsonb),
            '{followers}',
            to_jsonb(COALESCE((stats->>'followers')::int, 0) + :inc),
            true
          )
          WHERE id = :gasId::uuid
          `,
          { transaction: t, replacements: { gasId: gasUser.id, inc: newFollowerIds.length } }
        );
      });
    }

    console.log(`🎯 Cible: @${gasUser.username} (${gasUser.id})`);
    console.log('');

    console.log(`👤 Bots attendus: ${botCount}`);
    console.log(`✅ Bots créés: ${createdCount}`);
    if (sharedPlainPassword) {
      console.log(`🔑 Mot de passe (même pour tous les nouveaux bots de ce run): ${sharedPlainPassword}`);
    }
    console.log(`➕ Abonnements créés vers @${gasUser.username}: ${totalNewFollows}`);
    console.log(`⏭️ Abonnements déjà existants: ${totalExistingFollows}`);
    console.log('🎉 Terminé');
  } catch (error) {
    logger.error('Erreur script createBotAccountsAndFollowGas:', error);
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

// Exécuter le script si appelé directement
if (require.main === module) {
  createBotAccountsAndFollowGas();
}

module.exports = createBotAccountsAndFollowGas;

