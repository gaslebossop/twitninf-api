const { DataTypes } = require('sequelize');

/**
 * Marketplace de contrats sponsorisés réservée aux créateurs Ultra (côté
 * `creator_user_id`) — voir [[offre-createur-2026-08]] pour le précédent de
 * schéma (table neuve plutôt que colonnes ajoutées, contrainte de
 * `sync({alter:false})`).
 *
 * Argent : aucun mécanisme d'escrow dédié — réutilise le trésor NF existant.
 * `escrow_transaction_id` est renseigné par `spendCoins` (marque -> trésor) à
 * l'acceptation, `release_transaction_id` par `rewardUser` (trésor ->
 * créateur ou trésor -> marque en cas d'annulation) à la résolution. Voir
 * `creatorContractService.js`.
 *
 * `draft_content` ne porte que le DERNIER brouillon soumis ; l'historique
 * complet (chaque brouillon + le retour de la marque) vit dans
 * `revision_history`, en append-only.
 */
module.exports = function (sequelize) {
  const CreatorContract = sequelize.define('CreatorContract', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    brand_user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    creator_user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    price_nf: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    currency_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    brief: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // pending: en attente de réponse du créateur (aucun argent bloqué).
    // rejected: créateur a refusé (terminal, aucun argent bloqué).
    // accepted: créateur a accepté, séquestre verrouillé, en attente de brouillon.
    // draft_submitted: un brouillon attend la revue de la marque.
    // changes_requested: la marque a demandé une modif, en attente d'un nouveau brouillon.
    // approved: la marque a validé — publié, NF libérés (terminal).
    // cancelled: annulé par le créateur pendant qu'il attendait la marque, remboursé (terminal).
    status: {
      type: DataTypes.ENUM(
        'pending', 'rejected', 'accepted', 'draft_submitted',
        'changes_requested', 'approved', 'cancelled'
      ),
      defaultValue: 'pending',
      allowNull: false,
    },
    draft_content: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    revision_history: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },
    tweet_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    escrow_transaction_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    release_transaction_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    published_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'creator_contracts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['brand_user_id'] },
      { fields: ['creator_user_id'] },
      { fields: ['status'] },
      { fields: ['tweet_id'] },
    ],
  });

  return CreatorContract;
};
