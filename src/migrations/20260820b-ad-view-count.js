/**
 * Vues publicitaires dénormalisées à part de `view_count`.
 *
 * Une impression publicitaire (`AdImpression`, cf. `adService.recordImpression`)
 * pour une publicité ciblant un tweet (`target_type = 'tweet'`) incrémente
 * maintenant aussi `view_count` du tweet promu — pour que ces vues remontent
 * dans les stats du compte (`/api/user-stats/:userId/overview`), le profil et
 * le classement algo, au même titre que n'importe quelle autre vue.
 *
 * `ad_view_count` garde la part payée au CPM séparément : elle est
 * soustraite dans `tweetMonetizationService` (`computeEffectiveViews`) pour
 * qu'une vue déjà payée par l'annonceur ne soit pas payée une seconde fois
 * par la monétisation — sans quoi un compte qui boost son propre tweet se
 * rémunérerait en partie tout seul.
 *
 * ⚠ Ce fichier n'est PAS joué en production : `src/database/migrate.js`
 * contient le même DDL, idempotent.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tweets', 'ad_view_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tweets', 'ad_view_count');
  },
};
