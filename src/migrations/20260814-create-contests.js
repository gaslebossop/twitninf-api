/**
 * Concours attachés à un tweet : cagnotte déclarée, conditions de
 * participation, tirage vérifiable à l'échéance.
 *
 * `sequelize.sync({ force: false })` crée déjà ces tables au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma.
 *
 * ⚠️ La valeur `concours` du type de tweet, elle, n'est PAS créée par `sync`
 * (Sequelize n'ajoute jamais de valeur à un ENUM existant). Elle est ajoutée
 * ici, et aussi dans `scripts/autoMigration.js` qui tourne à chaque démarrage
 * — sans quoi la publication d'un concours échoue en production sur
 * « invalid input value for enum enum_tweets_tweet_type ».
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ADD VALUE ne peut pas tourner dans une transaction sur les anciennes
    // versions de PostgreSQL ; IF NOT EXISTS rend l'appel rejouable.
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_tweets_tweet_type" ADD VALUE IF NOT EXISTS 'concours';`
    );

    await queryInterface.createTable('contests', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tweet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'tweets', key: 'id' },
        onDelete: 'CASCADE',
      },
      creator_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(120), allowNull: true },
      prize_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      prize_currency: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'EUR' },
      prize_note: { type: Sequelize.STRING(160), allowNull: true },
      winners_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      conditions: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      ends_at: { type: Sequelize.DATE, allowNull: false },
      status: {
        type: Sequelize.ENUM('open', 'drawing', 'closed', 'cancelled'),
        allowNull: false,
        defaultValue: 'open',
      },
      draw_seed: { type: Sequelize.STRING(64), allowNull: false },
      seed_commitment: { type: Sequelize.STRING(64), allowNull: false },
      drawn_at: { type: Sequelize.DATE, allowNull: true },
      entries_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      cancelled_reason: { type: Sequelize.STRING(160), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('contests', ['creator_id']);
    // Index du cron de tirage : « les concours ouverts dont l'échéance est
    // passée », joué toutes les minutes.
    await queryInterface.addIndex('contests', ['status', 'ends_at']);

    await queryInterface.createTable('contest_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      contest_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'contests', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      status: {
        type: Sequelize.ENUM('pending', 'eligible', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      rejected_reason: { type: Sequelize.STRING(80), allowNull: true },
      is_winner: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      rank: { type: Sequelize.INTEGER, allowNull: true },
      entered_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // Une seule participation par personne : la contrainte doit vivre en base,
    // un contrôle applicatif laisse passer deux requêtes simultanées.
    await queryInterface.addIndex('contest_entries', ['contest_id', 'user_id'], { unique: true });
    await queryInterface.addIndex('contest_entries', ['contest_id', 'is_winner']);
    await queryInterface.addIndex('contest_entries', ['user_id']);

    console.log('OK: tables contests et contest_entries creees');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('contest_entries');
    await queryInterface.dropTable('contests');
    // La valeur d'ENUM `concours` n'est pas retirée : PostgreSQL ne sait pas
    // supprimer une valeur d'un type énuméré, et des tweets peuvent encore la
    // porter.
    console.log('OK: tables contests et contest_entries supprimees');
  },
};
