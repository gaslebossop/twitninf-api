const { DataTypes, Model } = require('sequelize');

/** Lundi 00:00:00 UTC de la semaine ISO contenant `date` (par défaut maintenant). */
function currentWeekStart(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = dimanche ... 6 = samedi
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

class WeeklyTweetVote extends Model {
  static currentWeekStart(date) {
    return currentWeekStart(date);
  }

  // Pose ou change le vote de `userId` pour la semaine en cours — un seul
  // vote actif par utilisateur et par semaine (contrainte unique
  // user_id+week_start), donc "revoter" met juste à jour la ligne existante
  // plutôt que d'en créer une seconde.
  static async castVote(userId, tweetId, weekStart = currentWeekStart()) {
    const [vote] = await this.findOrCreate({
      where: { user_id: userId, week_start: weekStart },
      defaults: { tweet_id: tweetId },
    });
    if (vote.tweet_id !== tweetId) {
      await vote.update({ tweet_id: tweetId });
    }
    return vote;
  }

  static async voteForUser(userId, weekStart = currentWeekStart()) {
    const vote = await this.findOne({ where: { user_id: userId, week_start: weekStart } });
    return vote ? vote.tweet_id : null;
  }

  // Nombre de votes par tweet pour une semaine donnée — une requête groupée,
  // même patron que TweetLike.countLikesForTweets.
  static async countVotesForWeek(weekStart = currentWeekStart()) {
    const rows = await this.findAll({
      where: { week_start: weekStart },
      attributes: [
        'tweet_id',
        [this.sequelize.fn('COUNT', this.sequelize.col('id')), 'count'],
      ],
      group: ['tweet_id'],
      raw: true,
    });
    return new Map(rows.map((r) => [String(r.tweet_id), Number(r.count) || 0]));
  }
}

const weeklyTweetVoteSchema = {
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
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tweets', key: 'id' },
  },
  // Lundi 00:00 UTC de la semaine votée — identifie la semaine sans dépendre
  // du fuseau horaire du lecteur ni recalculer un intervalle à chaque requête.
  week_start: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
};

const modelOptions = {
  modelName: 'WeeklyTweetVote',
  tableName: 'weekly_tweet_votes',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['user_id', 'week_start'] },
    { fields: ['tweet_id', 'week_start'] },
  ],
};

function initWeeklyTweetVoteModel(sequelize) {
  WeeklyTweetVote.init(weeklyTweetVoteSchema, {
    ...modelOptions,
    sequelize,
  });
}

module.exports = WeeklyTweetVote;
module.exports.initWeeklyTweetVoteModel = initWeeklyTweetVoteModel;
module.exports.weeklyTweetVoteSchema = weeklyTweetVoteSchema;
module.exports.modelOptions = modelOptions;
module.exports.currentWeekStart = currentWeekStart;
