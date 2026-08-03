const { DataTypes } = require('sequelize');

/**
 * Verrou payant posé par un créateur sur un de ses contenus.
 *
 * Une ligne = un contenu verrouillé. Le contenu lui-même (tweet, story,
 * replay) n'est pas dupliqué ici : il reste dans sa table d'origine, et c'est
 * la lecture qui est filtrée. Recopier le texte serait la garantie qu'un jour
 * les deux versions divergent — et que celle qu'on vend n'est pas celle que
 * l'auteur a écrite.
 *
 * `price_twc` est figé au moment où l'acheteur paie (recopié dans
 * `content_purchases`) : un créateur qui augmente son prix ne peut pas
 * réclamer la différence à ceux qui ont déjà payé.
 *
 * Poser un verrou est réservé au palier Pro, vérifié en base à chaque appel —
 * l'absence du bouton dans l'app n'est que du confort d'interface.
 */

const PaidContent = (sequelize) => sequelize.define('PaidContent', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  creator_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /**
   * Type de contenu verrouillé. Pas de contrainte de clé étrangère : les
   * trois cibles vivent dans des tables différentes, et une FK polymorphe
   * n'existe pas en SQL. L'intégrité est tenue par le service, qui vérifie
   * l'existence ET la propriété du contenu avant d'écrire.
   */
  content_type: {
    type: DataTypes.ENUM('tweet', 'story', 'live_replay'),
    allowNull: false,
  },
  content_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  currency_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'virtual_currencies', key: 'id' },
  },
  price_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
  },
  /**
   * Accroche affichée au-dessus du verrou, écrite par le créateur.
   *
   * Facultative : sans elle, le service prend le début du contenu. Un extrait
   * choisi vend mieux qu'un extrait tronqué au hasard, mais imposer sa
   * rédaction ferait abandonner la moitié des créateurs à la première vente.
   */
  preview_text: {
    type: DataTypes.STRING(280),
    allowNull: true,
  },
  /**
   * Un verrou retiré n'est jamais supprimé : les achats déjà encaissés y
   * font référence, et l'acheteur garde son accès à vie. Le retirer de la
   * table effacerait la preuve de ce qu'il a payé.
   */
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  /** Compteurs dénormalisés — le tableau de bord des ventes s'affiche sans agrégat. */
  purchases_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  gross_twc: {
    type: DataTypes.DECIMAL(20, 4),
    defaultValue: 0,
  },
  net_twc: {
    type: DataTypes.DECIMAL(20, 4),
    defaultValue: 0,
  },
  /** Taux de commission appliqué, recopié pour l'audit d'une vente ancienne. */
  platform_fee_rate: {
    type: DataTypes.DECIMAL(6, 4),
    allowNull: false,
  },
  unlocked_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'paid_contents',
  timestamps: true,
  underscored: true,
  indexes: [
    // Un contenu ne peut porter qu'un seul verrou, actif ou retiré.
    { unique: true, fields: ['content_type', 'content_id'] },
    { fields: ['creator_id', 'is_active'] },
    { fields: ['created_at'] },
  ],
});

module.exports = PaidContent;
