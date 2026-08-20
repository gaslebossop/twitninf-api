const { DataTypes, Model } = require('sequelize');

class TweetBookmark extends Model {
  // Bascule le favori : crée s'il n'existait pas, retire sinon. Renvoie l'état
  // résultant, jamais un booléen fixe — contrairement à l'ancienne route qui
  // répondait toujours `bookmarked: true`.
  static async toggle(userId, tweetId) {
    const existing = await this.findOne({ where: { user_id: userId, tweet_id: tweetId } });
    if (existing) {
      await existing.destroy();
      return false;
    }
    await this.create({ user_id: userId, tweet_id: tweetId });
    return true;
  }

  static async isBookmarked(userId, tweetId) {
    const row = await this.findOne({ where: { user_id: userId, tweet_id: tweetId } });
    return !!row;
  }

  // Parmi `tweetIds`, ceux que `userId` a mis en favori — même patron que
  // TweetLike.likedTweetIdsForUser.
  static async bookmarkedTweetIdsForUser(userId, tweetIds = []) {
    const ids = [...new Set(tweetIds.map(String))].filter(Boolean);
    if (!userId || ids.length === 0) return new Set();

    const rows = await this.findAll({
      where: { user_id: userId, tweet_id: ids },
      attributes: ['tweet_id'],
      raw: true,
    });

    return new Set(rows.map((r) => String(r.tweet_id)));
  }
}

const tweetBookmarkSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tweets', key: 'id' }
  }
};

const modelOptions = {
  modelName: 'TweetBookmark',
  tableName: 'tweet_bookmarks',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['user_id', 'tweet_id'] },
    { fields: ['tweet_id'] },
    { fields: ['user_id'] }
  ]
};

function initTweetBookmarkModel(sequelize) {
  TweetBookmark.init(tweetBookmarkSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = TweetBookmark;
module.exports.initTweetBookmarkModel = initTweetBookmarkModel;
module.exports.tweetBookmarkSchema = tweetBookmarkSchema;
module.exports.modelOptions = modelOptions;
