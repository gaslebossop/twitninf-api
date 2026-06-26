/**
 * Image de bannière profil (URL publique).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'banner', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    console.log('OK: colonne users.banner ajoutee');
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'banner');
    console.log('OK: colonne users.banner supprimee');
  },
};
