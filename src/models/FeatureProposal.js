const { DataTypes, Model } = require('sequelize');

/**
 * Une fonctionnalité proposée par un utilisateur — « La Forge ».
 *
 * Quelqu'un décrit ce qu'il voudrait voir dans l'app. Le staff tranche. Si
 * c'est construit, l'auteur touche des NF, dont le montant est choisi par le
 * staff au moment de la décision.
 *
 * ── Pourquoi une table à part et pas un ticket de support ─────────────────
 * C'était la solution la moins chère : `support_tickets` a déjà des statuts,
 * des réponses du staff et une file. Mais un ticket se FERME, alors qu'une
 * idée se construit — et surtout un ticket ne porte aucun montant. Poser une
 * récompense en NF sur un objet dont ce n'est pas le sujet aurait demandé une
 * colonne nulle sur toutes les autres lignes, et aurait mélangé dans la même
 * file « mon compte est bloqué » et « ajoutez les sondages ». Les deux
 * demandent une attention différente et un délai différent.
 *
 * ── La récompense ─────────────────────────────────────────────────────────
 * `reward_nf` est ce que le staff a DÉCIDÉ. `reward_paid_at` est ce qui a été
 * effectivement versé au grand livre. Les deux sont séparés exprès : le
 * versement passe par `EconomyLedger.rewardFromTreasury`, qui peut échouer
 * (trésorerie insuffisante) après que la décision a été prise. Les confondre
 * en un seul champ rendrait impossible de distinguer « pas encore payé » de
 * « payé », donc impossible de rejouer un versement sans risquer de payer
 * deux fois.
 *
 * C'est `reward_paid_at IS NULL` qui garde l'unicité du versement, pas une
 * intention : le service refuse de payer une ligne déjà horodatée.
 */
class FeatureProposal extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  author_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },

  title: {
    type: DataTypes.STRING(120),
    allowNull: false,
    validate: { len: [8, 120] }
  },

  /**
   * Le corps de la proposition.
   *
   * Minimum 40 caractères : une idée tenant en cinq mots (« ajoutez les
   * stories ») ne dit ni le problème qu'elle résout ni ce qu'on attend, et
   * elle coûte au staff un aller-retour pour chaque envoi.
   */
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: { len: [40, 2000] }
  },

  /** Le coin de l'app visé. Sert à router la lecture, pas à décider. */
  area: {
    type: DataTypes.ENUM(
      'feed',
      'profil',
      'messages',
      'economie',
      'carte',
      'video',
      'autre'
    ),
    allowNull: false,
    defaultValue: 'autre'
  },

  /**
   * Le cycle de vie, et il est linéaire jusqu'à la sortie.
   *
   * `received` → `reviewing` → `accepted` → `built`, avec `declined`
   * atteignable depuis n'importe où. Pas d'état « en attente de l'auteur » :
   * la Forge n'est pas un support, on ne demande pas de complément — une idée
   * trop floue est refusée avec sa raison, ce qui est plus honnête qu'un
   * ticket qui pourrit ouvert.
   */
  status: {
    type: DataTypes.ENUM('received', 'reviewing', 'accepted', 'built', 'declined'),
    allowNull: false,
    defaultValue: 'received'
  },

  /** Montant décidé par le staff. `null` tant que rien n'est décidé. */
  reward_nf: {
    type: DataTypes.DECIMAL(18, 2),
    allowNull: true
  },

  /** Horodatage du VERSEMENT effectif au grand livre. Garde l'unicité. */
  reward_paid_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  /**
   * Le mot du staff, montré à l'auteur tel quel.
   *
   * Obligatoire côté service pour un refus : « refusée » sans raison est la
   * façon la plus sûre de ne plus jamais recevoir d'idée de quelqu'un.
   */
  staff_note: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  decided_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },

  decided_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
};

const options = {
  modelName: 'FeatureProposal',
  tableName: 'feature_proposals',
  timestamps: true,
  underscored: true,
  indexes: [
    // « Mes idées », l'écran par défaut : les siennes, les plus récentes d'abord.
    { fields: ['author_id', 'created_at'] },
    // La file du staff, et la vitrine des idées construites.
    { fields: ['status', 'created_at'] },
    // Le rattrapage des versements décidés mais non payés.
    { fields: ['reward_paid_at'] }
  ]
};

function initFeatureProposalModel(sequelize) {
  FeatureProposal.init(schema, { ...options, sequelize });
  return FeatureProposal;
}

module.exports = FeatureProposal;
module.exports.initFeatureProposalModel = initFeatureProposalModel;
