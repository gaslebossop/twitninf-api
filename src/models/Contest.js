const { DataTypes, Model } = require('sequelize');
const crypto = require('crypto');

/**
 * Concours attaché à un tweet : une cagnotte, des conditions à remplir, une
 * date de fin, et un tirage automatique parmi les participants éligibles.
 *
 * ── Pourquoi une table à part et pas des colonnes sur `tweets` ────────────
 * Un concours a son propre cycle de vie (ouvert → tirage → clos), ses
 * participants et son historique de tirage. Le mettre dans `tweets`
 * ajouterait une dizaine de colonnes nulles à 99,99 % des lignes de la table
 * la plus lue de la base.
 *
 * ── Montant, devise et séquestre ─────────────────────────────────────────
 * La cagnotte est une VRAIE somme, dans une monnaie du catalogue
 * (`virtual_currencies`) : NF, EUR interne, ou n'importe quelle monnaie
 * communautaire. Aucune saisie libre — une devise inventée serait un montant
 * que personne ne peut verser.
 *
 * À la création, `prize_amount × winners_count` est PRÉLEVÉ sur le
 * portefeuille de l'organisateur et déposé à la trésorerie
 * (`EconomyLedger.spendToTreasury`). C'est ce qui rend le concours crédible :
 * l'argent a déjà quitté le compte de celui qui promet. Au tirage, chaque
 * gagnant est crédité depuis la trésorerie ; toute part non attribuée (moins
 * de gagnants éligibles que prévu, concours annulé) revient à l'organisateur.
 * `escrow_status` dit où en est cet argent, et c'est lui qui empêche de payer
 * ou de rembourser deux fois.
 *
 * `prize_currency` garde le symbole (NF, KOSP…) en clair : c'est ce qui
 * s'affiche partout, et ça évite une jointure sur chaque carte du fil.
 *
 * ── Tirage vérifiable ────────────────────────────────────────────────────
 * Le tirage n'est pas un `ORDER BY RANDOM()` : il est reproductible à partir
 * d'une graine. À la création, la graine est tirée puis GARDÉE SECRÈTE, et
 * seule son empreinte (`seed_commitment`) est publiée. Au tirage, la graine
 * est révélée : n'importe qui peut alors recalculer l'ordre
 * `sha256(graine + ':' + user_id)` et vérifier que les gagnants annoncés sont
 * bien les premiers. Publier la graine dès la création aurait laissé chacun
 * calculer d'avance s'il valait mieux participer ou non.
 */
class Contest extends Model {
  /**
   * Conditions par défaut. Toute condition absente vaut « non exigée » : un
   * concours créé par une ancienne version du client ne doit pas se mettre à
   * exiger quelque chose que son auteur n'a jamais coché.
   */
  static normalizeConditions(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const bool = (v) => v === true || v === 'true';
    const count = (v, max) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.min(n, max);
    };
    return {
      follow_creator: bool(c.follow_creator),
      like_tweet: bool(c.like_tweet),
      retweet_tweet: bool(c.retweet_tweet),
      reply_tweet: bool(c.reply_tweet),
      min_account_age_days: count(c.min_account_age_days, 3650),
      min_followers: count(c.min_followers, 1000000),
    };
  }

  /** Graine du tirage + empreinte publiée à la création. */
  static newSeed() {
    const seed = crypto.randomBytes(32).toString('hex');
    return { seed, commitment: crypto.createHash('sha256').update(seed).digest('hex') };
  }

  /**
   * Clé de classement d'un participant. Déterministe et vérifiable par
   * n'importe qui une fois la graine révélée.
   */
  static drawKey(seed, userId) {
    return crypto.createHash('sha256').update(`${seed}:${userId}`).digest('hex');
  }

  /** Vue publique : ne révèle la graine qu'une fois le tirage effectué. */
  toPublicJSON() {
    const json = this.get({ plain: true });
    if (json.status !== 'closed') delete json.draw_seed;
    return json;
  }
}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Le tweet qui porte le concours. Un tweet = au plus un concours.
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
    references: { model: 'tweets', key: 'id' }
  },

  creator_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },

  title: {
    type: DataTypes.STRING(120),
    allowNull: true
  },

  // Gain PAR gagnant. DECIMAL(20,8) comme les portefeuilles : un montant qui
  // transite par le grand livre ne doit pas perdre de décimales en route.
  prize_amount: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    validate: { min: 0 }
  },

  // Monnaie du catalogue (NF, EUR interne, monnaies communautaires).
  // Nullable uniquement pour les concours créés avant le séquestre, qui
  // n'avaient qu'un code de devise saisi à la main.
  currency_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'virtual_currencies', key: 'id' }
  },

  // Symbole dénormalisé (NF, KOSP…) : affiché sur chaque carte du fil, une
  // jointure par carte serait payée à chaque défilement.
  prize_currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: 'NF'
  },

  // Ce qui a réellement été prélevé à la création : prize_amount ×
  // winners_count au moment du prélèvement. Stocké plutôt que recalculé —
  // c'est la somme à rembourser, elle ne doit pas bouger si le modèle change.
  escrow_total: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },

  // `none` = concours hérité, sans séquestre. `held` = l'argent est à la
  // trésorerie. `paid` / `refunded` = il en est ressorti. Ce champ est le
  // garde-fou contre un double versement ou un double remboursement.
  escrow_status: {
    type: DataTypes.ENUM('none', 'held', 'paid', 'refunded'),
    allowNull: false,
    defaultValue: 'none'
  },

  // Précision libre : « par gagnant », « virement PayPal sous 48 h »…
  prize_note: {
    type: DataTypes.STRING(160),
    allowNull: true
  },

  winners_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1, max: 100 }
  },

  conditions: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },

  ends_at: {
    type: DataTypes.DATE,
    allowNull: false
  },

  // `drawing` n'est pas décoratif : il marque le concours pris en charge par
  // le tirage en cours et empêche deux passages du cron de tirer deux fois.
  status: {
    type: DataTypes.ENUM('open', 'drawing', 'closed', 'cancelled'),
    allowNull: false,
    defaultValue: 'open'
  },

  // Révélée seulement une fois le tirage fait (voir toPublicJSON).
  draw_seed: {
    type: DataTypes.STRING(64),
    allowNull: false
  },

  seed_commitment: {
    type: DataTypes.STRING(64),
    allowNull: false
  },

  drawn_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  // Compteur dénormalisé : le nombre de participants est affiché sur chaque
  // carte du fil, un COUNT() par carte serait payé à chaque scroll.
  entries_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },

  cancelled_reason: {
    type: DataTypes.STRING(160),
    allowNull: true
  }
};

const options = {
  modelName: 'Contest',
  tableName: 'contests',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['tweet_id'] },
    { fields: ['creator_id'] },
    // Index du cron de tirage : il cherche les concours ouverts échus.
    { fields: ['status', 'ends_at'] },
    { fields: ['currency_id'] }
  ]
};

function initContestModel(sequelize) {
  Contest.init(schema, { ...options, sequelize });
  return Contest;
}

module.exports = Contest;
module.exports.initContestModel = initContestModel;
