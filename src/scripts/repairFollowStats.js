const logger = require('../utils/logger');
const { sequelize, User, closeConnection } = require('../models');

async function repairFollowStats() {
  const onlyUsername = (process.env.USERNAME || '').trim() || null; // ex: gas

  try {
    await sequelize.authenticate();
    logger.info('Connexion à la base de données établie');

    let andClause = '';
    const replacements = {};

    if (onlyUsername) {
      const u = await User.findOne({ where: { username: onlyUsername }, attributes: ['id', 'username'] });
      if (!u) throw new Error(`Utilisateur introuvable: @${onlyUsername}`);
      andClause = 'AND u.id = :onlyUserId';
      replacements.onlyUserId = u.id;
    }

    const [result] = await sequelize.query(
      `
      WITH follower_counts AS (
        SELECT following_id AS user_id, COUNT(*)::int AS followers
        FROM user_follows
        WHERE status = 'active'
        GROUP BY following_id
      ),
      following_counts AS (
        SELECT follower_id AS user_id, COUNT(*)::int AS following
        FROM user_follows
        WHERE status = 'active'
        GROUP BY follower_id
      )
      UPDATE users u
      SET stats =
        jsonb_set(
          jsonb_set(
            COALESCE(u.stats, '{}'::jsonb),
            '{followers}',
            to_jsonb(COALESCE(fc.followers, 0)),
            true
          ),
          '{following}',
          to_jsonb(COALESCE(foc.following, 0)),
          true
        )
      FROM follower_counts fc
      FULL OUTER JOIN following_counts foc ON foc.user_id = fc.user_id
      WHERE u.id = COALESCE(fc.user_id, foc.user_id)
      ${andClause}
      RETURNING u.id
      `,
      { replacements }
    );

    const updated = Array.isArray(result) ? result.length : 0;
    console.log(`✅ Stats réparées (followers/following). Users impactés: ${updated}${onlyUsername ? ` (scope: @${onlyUsername})` : ''}`);
  } catch (error) {
    logger.error('Erreur script repairFollowStats:', error);
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
  repairFollowStats();
}

module.exports = repairFollowStats;

