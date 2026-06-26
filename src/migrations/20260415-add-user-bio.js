/**
 * Ajoute la colonne bio (texte court) au profil utilisateur.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'bio', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    console.log('OK: colonne users.bio ajoutee');
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'bio');
    console.log('OK: colonne users.bio supprimee');
  },
};
