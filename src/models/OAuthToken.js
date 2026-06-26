const { DataTypes } = require('sequelize');

module.exports = function(sequelize) {
  const OAuthToken = sequelize.define('OAuthToken', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    developer_app_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    access_token: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    refresh_token: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    scopes: {
      type: DataTypes.JSON,
      defaultValue: [],
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    }
  }, {
    tableName: 'oauth_tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return OAuthToken;
};
