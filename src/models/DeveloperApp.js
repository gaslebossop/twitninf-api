const { DataTypes } = require('sequelize');

module.exports = function(sequelize) {
  const DeveloperApp = sequelize.define('DeveloperApp', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    client_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    client_secret: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    redirect_uris: {
      type: DataTypes.JSON,
      defaultValue: [],
      allowNull: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    }
  }, {
    tableName: 'developer_apps',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return DeveloperApp;
};
