/**
 * Ce qu'un compte a RÉCLAMÉ sur une quête — et rien d'autre.
 *
 * ── Pourquoi la progression n'est pas stockée ici ─────────────────────────
 * L'ancienne table `user_challenges` stockait `progress` en dur, ce qui
 * imposait de la tenir à jour : cinq routes `update-*-progress` existaient
 * pour ça, appelables par le client, et il fallait s'y souvenir d'incrémenter
 * à chaque endroit du code qui publiait un tweet ou posait un like. Un oubli,
 * et la quête ne bougeait plus. Un client malveillant, et elle bougeait trop.
 *
 * La progression est désormais DÉRIVÉE : recomptée depuis les tables qui font
 * déjà autorité (`tweets`, `tweet_likes`, `transactions`) au moment où on la
 * lit, et re-vérifiée au moment de la remise. Elle ne peut donc pas dériver de
 * la réalité, et aucun appel client ne peut la faire avancer.
 *
 * Ne reste ici que ce qui n'est déductible de rien : la réclamation, sa date,
 * et ce qui a réellement été accordé — un lot à tirage n'existe qu'une fois
 * tiré.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TwQuestClaim = sequelize.define('TwQuestClaim', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    event_slug: { type: DataTypes.STRING(64), allowNull: false },
    quest_id: { type: DataTypes.STRING(64), allowNull: false },

    granted: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'La récompense RÉELLEMENT accordée, tirage compris.',
    },
    claimed_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'tw_quest_claims',
    timestamps: true,
    underscored: true,
    indexes: [
      // La contrainte qui empêche la double remise. Elle doit vivre en BASE :
      // un contrôle applicatif laisse passer deux requêtes simultanées, et
      // c'est exactement ce que tente quelqu'un qui veut doubler un gain.
      {
        fields: ['user_id', 'event_slug', 'quest_id'],
        unique: true,
        name: 'tw_quest_claims_unique',
      },
      { fields: ['user_id', 'event_slug'] },
    ],
  });

  /** Les quêtes déjà réclamées par ce compte sur cet événement. */
  TwQuestClaim.forUser = async function (userId, eventSlug) {
    return this.findAll({ where: { user_id: userId, event_slug: eventSlug } });
  };

  return TwQuestClaim;
};
