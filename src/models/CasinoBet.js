const { DataTypes } = require('sequelize');

class CasinoBet {
  static initCasinoBetModel(sequelize) {
    return sequelize.define('CasinoBet', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' }
      },
      currencyId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'virtual_currencies', key: 'id' }
      },
      game: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'dice'
      },
      betAmount: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false
      },
      winChance: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        comment: 'Chance de gain en % choisie par le joueur'
      },
      multiplier: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false
      },
      roll: {
        type: DataTypes.DECIMAL(7, 4),
        allowNull: false,
        comment: 'Tirage 0-100, gagnant si roll < winChance'
      },
      won: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      payout: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0
      }
    }, {
      tableName: 'casino_bets',
      timestamps: true,
      updatedAt: false,
      indexes: [
        { fields: ['user_id', 'created_at'] }
      ]
    });
  }
}

module.exports = CasinoBet;
