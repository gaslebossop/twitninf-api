const { DataTypes } = require('sequelize');

/**
 * Session de connexion d'un appareil.
 *
 * Le jeton de rafraîchissement est opaque (aléatoire, pas un JWT) et n'est
 * jamais stocké en clair : seul son SHA-256 est conservé. Chaque usage le fait
 * tourner — l'ancienne ligne est révoquée et une nouvelle est créée avec la
 * même `family_id`. Présenter un jeton déjà tourné signale donc un rejeu et
 * entraîne la révocation de toute la famille.
 *
 * C'est ce qui permet à la fois des sessions qui ne se coupent plus (le
 * `expires_at` glisse à chaque rotation) et une révocation réelle côté
 * serveur, absente jusqu'ici.
 */
module.exports = function (sequelize) {
  const Session = sequelize.define('Session', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    refresh_token_hash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    // Lie toutes les rotations successives d'une même connexion.
    family_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    device_id: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    platform: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    app_version: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    last_used_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revoked_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revoked_reason: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
  }, {
    tableName: 'sessions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['refresh_token_hash'], unique: true },
      { fields: ['user_id', 'revoked_at'] },
      { fields: ['family_id'] },
      { fields: ['expires_at'] },
    ],
  });

  return Session;
};
