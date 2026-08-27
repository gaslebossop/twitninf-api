const { DataTypes } = require('sequelize');

/**
 * Un strike posé par un abonné Ultra bloque UNIQUEMENT la diffusion d'un
 * tweet (`Tweet.moderation_status = 'not_eligible'`, déjà le mécanisme
 * utilisé pour exclure un tweet du fil/recherche sans le supprimer — voir
 * [[filtre-qualite-tweets]]). Aucun argent ne bouge : la monétisation reste
 * intacte tant qu'un humain ne l'a pas traitée séparément.
 *
 * Contester renvoie le tweet dans le circuit de modération NORMAL
 * (`moderation_status = 'pending'`), pas dans un outil dédié — la revue est
 * donc celle, déjà en place, que PolicierCongo/la modération humaine
 * appliquent à tout le reste.
 */
module.exports = function (sequelize) {
  const TweetStrike = sequelize.define('TweetStrike', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tweet_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    striker_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    author_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // 'active' = diffusion bloquée. 'contested' = renvoyé en modération
    // normale, en attente de verdict humain. 'upheld' = modération a confirmé
    // le retrait. 'reversed' = modération a rétabli le tweet, strike annulé.
    status: {
      type: DataTypes.ENUM('active', 'contested', 'upheld', 'reversed'),
      defaultValue: 'active',
      allowNull: false,
    },
    // Statut de modération du tweet avant le strike, pour pouvoir le
    // restaurer EXACTEMENT si le strike est annulé plutôt que de deviner
    // 'approved' à sa place.
    previous_moderation_status: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  }, {
    tableName: 'tweet_strikes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['tweet_id'] },
      { fields: ['striker_id'] },
      { fields: ['author_id'] },
    ],
  });

  return TweetStrike;
};
