const { DataTypes } = require('sequelize');

/**
 * Publication programmée — avantage abonné.
 *
 * Le tweet n'existe pas encore : tant qu'il est ici, il n'est ni visible, ni
 * comptabilisé, ni recommandé. C'est pour ça qu'il n'est pas stocké comme un
 * `Tweet` marqué « caché » : un tweet caché finit toujours par fuiter par une
 * requête qui a oublié le filtre.
 *
 * `mode = best_time` ne fige pas l'heure à la création : elle est recalculée
 * par le worker au moment de publier, à partir des créneaux réellement
 * observés sur le compte. Figer l'heure à la création la rendrait fausse pour
 * une publication programmée trois semaines à l'avance.
 */

const ScheduledTweet = (sequelize) => sequelize.define('ScheduledTweet', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  /** Mêmes structures que `tweets.media` : le worker les recopie telles quelles. */
  media: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  /** Réponse programmée à un tweet existant. */
  reply_to_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tweets', key: 'id' },
  },
  mode: {
    type: DataTypes.ENUM('exact', 'best_time'),
    defaultValue: 'exact',
  },
  /**
   * Heure visée. En mode `best_time`, c'est la borne basse : le worker
   * cherche le meilleur créneau APRÈS cette date, jamais avant — sinon une
   * publication préparée pour lundi partirait dimanche soir.
   */
  scheduled_for: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  /** Créneau finalement retenu en mode `best_time`, écrit à la publication. */
  resolved_for: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('pending', 'publishing', 'published', 'failed', 'canceled'),
    defaultValue: 'pending',
  },
  published_tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tweets', key: 'id' },
  },
  published_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  /**
   * Nombre de tentatives ratées. Au-delà du plafond du worker, la ligne passe
   * en `failed` et l'auteur est prévenu : une file qui retente indéfiniment
   * sur un contenu refusé par la modération tourne pour rien.
   */
  attempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  last_error: {
    type: DataTypes.STRING(300),
    allowNull: true,
  },
  /** Verrouillage du worker : évite qu'une seconde instance reprenne la ligne. */
  locked_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'scheduled_tweets',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id', 'status'] },
    // La requête du worker : ce qui est dû, dans l'ordre.
    { fields: ['status', 'scheduled_for'] },
  ],
});

module.exports = ScheduledTweet;
