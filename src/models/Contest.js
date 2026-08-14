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
 * ── Montant et devise ────────────────────────────────────────────────────
 * `prize_amount` + `prize_currency` sont DÉCLARATIFS : le créateur annonce ce
 * qu'il met en jeu, dans la devise qu'il veut (EUR, USD, XAF, NF…), et règle
 * lui-même le gagnant. Aucun débit automatique n'est fait ici — séquestrer
 * des fonds supposerait un portefeuille par devise, ce qui n'existe pas.
 * Le champ sert à afficher l'enjeu et à garder trace de ce qui a été promis.
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

  // Enjeu déclaré. DECIMAL et pas FLOAT : un montant d'argent affiché ne doit
  // pas dériver à l'arrondi binaire.
  prize_amount: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
    validate: { min: 0 }
  },

  // Code libre en majuscules (EUR, USD, XAF, NF, BTC…) : le concours n'est pas
  // limité aux devises que la plateforme sait convertir.
  prize_currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: 'EUR'
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
    { fields: ['status', 'ends_at'] }
  ]
};

function initContestModel(sequelize) {
  Contest.init(schema, { ...options, sequelize });
  return Contest;
}

module.exports = Contest;
module.exports.initContestModel = initContestModel;
