const { DataTypes } = require('sequelize');

class UserWallet {
  static initUserWalletModel(sequelize) {
    return sequelize.define('UserWallet', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'ID de l\'utilisateur propriétaire du portefeuille'
      },
      currencyId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'virtual_currencies',
          key: 'id'
        },
        comment: 'ID de la cryptomonnaie'
      },
      balance: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Solde en cryptomonnaie'
      },
      totalEarned: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total gagné depuis le début'
      },
      totalSpent: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total dépensé depuis le début'
      },
      lastPurchaseDate: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Dernière date d\'achat'
      },
      totalPurchased: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total acheté avec de l\'argent réel'
      },
      loyaltyPoints: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Points de fidélité pour les bonus d\'achat'
      },
      isLocked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Si le portefeuille est verrouillé'
      },
      lockReason: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Raison du verrouillage'
      },
      lastMiningDate: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Dernier minage (app Windows)'
      },
      dailyMiningCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Nombre de minages effectués le jour de lastMiningDate'
      }
    }, {
      tableName: 'user_wallets',
      timestamps: true,
      indexes: [
        {
          fields: ['user_id', 'currency_id'],
          unique: true
        },
        {
          fields: ['user_id']
        },
        {
          fields: ['currency_id']
        }
      ]
    });
  }
}

module.exports = UserWallet;
