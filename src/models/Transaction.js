const { DataTypes } = require('sequelize');

class Transaction {
  static initTransactionModel(sequelize) {
    return sequelize.define('Transaction', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      transactionHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        comment: 'Hash unique de la transaction'
      },
      fromUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'ID de l\'expéditeur (null pour les récompenses système)'
      },
      toUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'ID du destinataire'
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
      amount: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        comment: 'Montant de la transaction'
      },
      amountInEur: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        comment: 'Valeur en euros au moment de la transaction'
      },
      type: {
        type: DataTypes.ENUM('TRANSFER', 'MINING', 'PURCHASE', 'REWARD', 'REFUND', 'SYSTEM'),
        allowNull: false,
        comment: 'Type de transaction'
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING',
        comment: 'Statut de la transaction'
      },
      fee: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Frais de transaction'
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Description de la transaction'
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        comment: 'Métadonnées supplémentaires (action, tweet, etc.)'
      },
      confirmedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Date de confirmation de la transaction'
      }
    }, {
      tableName: 'transactions',
      timestamps: true,
      indexes: [
        {
          fields: ['transaction_hash']
        },
        {
          fields: ['from_user_id']
        },
        {
          fields: ['to_user_id']
        },
        {
          fields: ['currency_id']
        },
        {
          fields: ['type']
        },
        {
          fields: ['status']
        },
        {
          fields: ['created_at']
        }
      ]
    });
  }
}

module.exports = Transaction;
