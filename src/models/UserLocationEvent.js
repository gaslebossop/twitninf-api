const { DataTypes } = require('sequelize');

/**
 * Une capture de localisation par connexion applicative.
 *
 * Les coordonnees ne sont ecrites qu'apres consentement explicite et accord
 * du systeme. `capture_key` rend les retries reseau idempotents. Les routes de
 * statistiques ne restituent jamais latitude/longitude : elles n'utilisent
 * que des regroupements pays/region avec un seuil d'anonymat.
 */
module.exports = function UserLocationEventModel(sequelize) {
  return sequelize.define('UserLocationEvent', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    capture_key: {
      type: DataTypes.STRING(180),
      allowNull: false,
      unique: true,
    },
    permission_status: {
      type: DataTypes.STRING(24),
      allowNull: false,
    },
    latitude: {
      type: DataTypes.DECIMAL(9, 6),
      allowNull: true,
    },
    longitude: {
      type: DataTypes.DECIMAL(9, 6),
      allowNull: true,
    },
    accuracy_m: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    country_code: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    region: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    timezone: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    platform: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    client_captured_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    captured_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'user_location_events',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['capture_key'] },
      { fields: ['user_id', 'captured_at'] },
      { fields: ['country_code', 'region'] },
    ],
  });
};
