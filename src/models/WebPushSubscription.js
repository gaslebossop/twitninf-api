const { DataTypes, Model } = require('sequelize');

/**
 * Abonnement Web Push (norme W3C), un par navigateur ET par appareil.
 *
 * Rien à voir avec `users.id_notif`, qui porte le jeton Expo de l'app mobile :
 * un même compte peut avoir les deux, et doit recevoir sur les deux.
 *
 * L'`endpoint` est l'identité de l'abonnement — c'est l'URL du service de
 * poussée du navigateur (Google, Mozilla, Apple). Il est unique : le même
 * navigateur qui se réabonne rend le même endpoint, et on doit alors mettre
 * à jour la ligne existante, jamais en créer une seconde qui ferait deux
 * notifications identiques.
 */
class WebPushSubscription extends Model {
  static initWebPushSubscriptionModel(sequelize) {
    WebPushSubscription.init({
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      endpoint: {
        type: DataTypes.TEXT,
        allowNull: false,
        unique: true,
      },
      // Clés de chiffrement du navigateur : le serveur ne peut PAS lire ce
      // qu'il envoie sans elles, le contenu est chiffré de bout en bout.
      p256dh: { type: DataTypes.TEXT, allowNull: false },
      auth: { type: DataTypes.TEXT, allowNull: false },
      user_agent: { type: DataTypes.TEXT, allowNull: true },
      // Un abonnement mort n'est pas toujours signalé par un 410 : certains
      // services rendent des erreurs transitoires. On ne supprime qu'après
      // plusieurs échecs, ou immédiatement sur 404/410.
      failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_success_at: { type: DataTypes.DATE, allowNull: true },
    }, {
      sequelize,
      modelName: 'WebPushSubscription',
      tableName: 'web_push_subscriptions',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id'] },
      ],
    });

    return WebPushSubscription;
  }
}

module.exports = WebPushSubscription;
