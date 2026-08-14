/**
 * Élargit `message_reactions.emoji` de VARCHAR(8) à VARCHAR(32).
 *
 * Les réactions étaient limitées à six emojis courts codés en dur ; le
 * sélecteur libre (façon Instagram) autorise n'importe quel emoji, et les
 * emojis composés dépassent 8 caractères — « 👨‍👩‍👧‍👦 » en fait 11. Sans cet
 * élargissement, Postgres refuse l'insertion (« value too long »).
 *
 * Allonger un VARCHAR ne réécrit pas la table (Postgres >= 9.2) : l'opération
 * est immédiate même sur une table volumineuse.
 *
 * `sequelize.sync({ alter: false })` ne modifie AUCUNE colonne existante :
 * cette migration doit être jouée explicitement (elle l'est aussi au démarrage
 * du worker, via scripts/autoMigration.js).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('message_reactions', 'emoji', {
      type: Sequelize.STRING(32),
      allowNull: false,
    });
    console.log('OK: message_reactions.emoji elargi a VARCHAR(32)');
  },

  down: async (queryInterface, Sequelize) => {
    // Retour arrière possible seulement si aucune réaction ne dépasse 8
    // caractères — sinon Postgres refuse, et c'est tant mieux : tronquer
    // effacerait des réactions existantes.
    await queryInterface.changeColumn('message_reactions', 'emoji', {
      type: Sequelize.STRING(8),
      allowNull: false,
    });
    console.log('OK: message_reactions.emoji ramene a VARCHAR(8)');
  },
};
