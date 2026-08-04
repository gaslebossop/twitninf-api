'use strict';

const {
  runSubscriberTweetCreditBackfill,
} = require('../services/subscriberTweetCreditBackfill');

/**
 * Donne le solde de lancement aux abonnés déjà actifs. Le même marqueur durable
 * est partagé avec le bootstrap automatique de production.
 */
module.exports = {
  up: async (queryInterface) => {
    await runSubscriberTweetCreditBackfill(queryInterface.sequelize);
  },

  // Une dotation déjà consommée ne peut pas être retirée proprement. Le
  // rollback du schéma laisse donc volontairement ce backfill intact.
  down: async () => {},
};
