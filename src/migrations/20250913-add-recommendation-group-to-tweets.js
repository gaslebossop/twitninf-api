'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Ajouter la colonne recommendation_group à la table tweets
    await queryInterface.addColumn('tweets', 'recommendation_group', {
      type: Sequelize.ENUM('initial', 'expansion', 'viral', 'massive', 'excluded'),
      defaultValue: 'initial',
      allowNull: false
    });

    // Mettre à jour tous les tweets existants pour qu'ils soient dans le groupe 'initial'
    await queryInterface.sequelize.query(`
      UPDATE tweets 
      SET recommendation_group = 'initial' 
      WHERE recommendation_group IS NULL
    `);

    // Ajouter un index pour optimiser les requêtes
    await queryInterface.addIndex('tweets', ['recommendation_group'], {
      name: 'tweets_recommendation_group_idx'
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Supprimer l'index
    await queryInterface.removeIndex('tweets', 'tweets_recommendation_group_idx');
    
    // Supprimer la colonne
    await queryInterface.removeColumn('tweets', 'recommendation_group');
    
    // Supprimer le type ENUM
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_tweets_recommendation_group"');
  }
};
