/**
 * Bandeau "Spotlight" : le post le plus liké de la veille, en tête du fil.
 *
 * Une ligne par jour calendaire (fuseau Europe/Paris), calculée une fois par
 * un cron plutôt qu'agrégée à chaque requête. `status` distingue « le cron a
 * tourné et n'a rien trouvé d'éligible » (`no_winner`) de « le cron n'a pas
 * encore tourné » (aucune ligne) : sans ça, une nuit où le job plante en
 * silence est indiscernable en base d'une nuit sans gagnant légitime.
 *
 * `sequelize.sync({ force: false })` crée déjà cette table au démarrage ;
 * cette migration existe pour les environnements où la synchronisation
 * automatique est désactivée, et pour documenter le schéma.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('daily_spotlights', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      spotlight_date: { type: Sequelize.DATEONLY, allowNull: false },
      tweet_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'tweets', key: 'id' },
        onDelete: 'SET NULL',
      },
      like_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM('computed', 'no_winner'), allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('daily_spotlights', ['spotlight_date'], { unique: true });
    await queryInterface.addIndex('daily_spotlights', ['tweet_id']);

    console.log('OK: table daily_spotlights creee');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('daily_spotlights');
    console.log('OK: table daily_spotlights supprimee');
  },
};
