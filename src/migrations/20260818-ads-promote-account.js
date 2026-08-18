/**
 * Publicité : promouvoir un COMPTE et plus seulement un tweet.
 *
 * `advertisements.tweet_id` était NOT NULL. Une publicité de compte n'avait
 * donc aucune colonne où se poser : « on est obligé de promouvoir un tweet »
 * n'était pas une règle de produit, c'était une contrainte de schéma.
 *
 * `target_type` dit laquelle des deux cibles fait foi ; la contrainte
 * garantit qu'il y en a toujours exactement une de renseignée, pour qu'une
 * publicité ne puisse jamais pointer vers rien.
 *
 * ⚠ Ce fichier n'est PAS joué en production : `src/database/migrate.js`
 * contient le même DDL, idempotent. Il existe pour documenter le schéma et
 * pour les environnements où la synchronisation automatique est coupée.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('advertisements', 'target_type', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'tweet',
    });
    await queryInterface.addColumn('advertisements', 'target_user_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    });
    await queryInterface.changeColumn('advertisements', 'tweet_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'tweets', key: 'id' },
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE advertisements ADD CONSTRAINT advertisements_target_ck CHECK (
        (target_type = 'tweet'   AND tweet_id       IS NOT NULL) OR
        (target_type = 'profile' AND target_user_id IS NOT NULL)
      );
    `);
    await queryInterface.addIndex('advertisements', ['target_user_id'], {
      name: 'idx_advertisements_target_user',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('advertisements', 'idx_advertisements_target_user');
    await queryInterface.sequelize.query(
      'ALTER TABLE advertisements DROP CONSTRAINT IF EXISTS advertisements_target_ck;',
    );
    await queryInterface.removeColumn('advertisements', 'target_user_id');
    await queryInterface.removeColumn('advertisements', 'target_type');
  },
};
