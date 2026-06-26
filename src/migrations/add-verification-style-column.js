/**
 * Migration pour ajouter la colonne verification_style
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    try {
      // Ajouter la colonne verification_style
      await queryInterface.addColumn('users', 'verification_style', {
        type: Sequelize.ENUM('default', 'rose'),
        defaultValue: 'default',
        allowNull: false
      });

      console.log('✅ Colonne verification_style ajoutée avec succès');
    } catch (error) {
      console.error('❌ Erreur lors de l\'ajout de la colonne verification_style:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    try {
      // Supprimer la colonne verification_style
      await queryInterface.removeColumn('users', 'verification_style');
      
      // Supprimer le type ENUM
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_verification_style";');

      console.log('✅ Colonne verification_style supprimée avec succès');
    } catch (error) {
      console.error('❌ Erreur lors de la suppression de la colonne verification_style:', error);
      throw error;
    }
  }
};
