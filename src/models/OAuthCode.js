const { DataTypes } = require('sequelize');

module.exports = function(sequelize) {
  const OAuthCode = sequelize.define('OAuthCode', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    developer_app_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    redirect_uri: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    }
  }, {
    tableName: 'oauth_codes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  return OAuthCode;
};
