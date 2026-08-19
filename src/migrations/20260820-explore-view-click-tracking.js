/**
 * Suivi vues/clics du mur Explorer, séparé de `view_count`.
 *
 * `view_count` reste incrémenté par toute vue, Explorer compris — stats
 * créateur et classement algo inchangés. `explore_view_count` et
 * `explore_click_count` sont des compteurs dénormalisés dédiés, lus
 * uniquement par `tweetMonetizationService.js` pour reformuler la part
 * Explorer en clics plutôt qu'en vues (voir
 * `docs/superpowers/specs/2026-08-20-explore-view-click-tracking-design.md`).
 *
 * ⚠ Ce fichier n'est PAS joué en production : `src/database/migrate.js`
 * contient le même DDL, idempotent.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tweets', 'explore_view_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('tweets', 'explore_click_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tweets', 'explore_click_count');
    await queryInterface.removeColumn('tweets', 'explore_view_count');
  },
};
