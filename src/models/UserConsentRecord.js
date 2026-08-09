const { DataTypes } = require('sequelize');

/**
 * Journal APPEND-ONLY des accords et des retraits.
 *
 * C'est la preuve exigee par l'art. 7.1 du RGPD : etre capable de demontrer
 * quand, pour quelle finalite, sur quelle version du socle et depuis quel
 * client une personne a donne — ou retire — son accord. Une ligne ne doit
 * jamais etre modifiee ni supprimee : un retrait s'ajoute par-dessus. L'etat
 * courant, lui, est denormalise sur `users.consent_preferences`.
 */
module.exports = function UserConsentRecordModel(sequelize) {
  return sequelize.define('UserConsentRecord', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    consent_version: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    purpose: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    granted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    required: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(24),
      allowNull: false,
    },
    platform: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    app_version: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    // Empreinte HMAC de l'adresse, jamais l'adresse elle-meme : l'origine
    // reste demontrable sans conserver une donnee identifiante de plus.
    ip_fingerprint: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    recorded_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'user_consent_records',
    timestamps: false,
    indexes: [
      { fields: ['user_id', 'recorded_at'] },
      { fields: ['purpose', 'granted'] },
    ],
  });
};
