/**
 * Personnalisation de profil premium (couleurs, décoration d'avatar, à propos).
 *
 * `sequelize.sync({ alter: false })` ne rattrape PAS une colonne ajoutée à un
 * modèle existant : contrairement aux tables stories, celle-ci doit être
 * appliquée explicitement (voir ensureUsersProfileCustomizationColumn dans
 * models/index.js, appelé au démarrage).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'profile_customization', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: {},
    });
    console.log('OK: colonne users.profile_customization ajoutee');
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'profile_customization');
    console.log('OK: colonne users.profile_customization supprimee');
  },
};
