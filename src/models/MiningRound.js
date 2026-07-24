const { DataTypes } = require('sequelize');

class MiningRound {
  static initMiningRoundModel(sequelize) {
    return sequelize.define('MiningRound', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      currencyId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'virtual_currencies', key: 'id' }
      },
      challenge: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'Chaîne hexadécimale aléatoire à hasher avec un nonce'
      },
      difficulty: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: 'Palier de difficulté (sert au calcul de la récompense de base)'
      },
      target: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Cible numérique (32 bits) : hash valide si les 4 premiers octets < target'
      },
      engineType: {
        type: DataTypes.ENUM('cpu', 'gpu'),
        allowNull: false,
        defaultValue: 'cpu',
        comment: 'Pool de minage — GPU : cible 10x plus dure, récompense 10x plus grosse'
      },
      reward: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
        comment: 'Récompense NF pour le gagnant de ce round'
      },
      status: {
        type: DataTypes.ENUM('open', 'solved', 'expired'),
        allowNull: false,
        defaultValue: 'open'
      },
      winnerUserId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
      },
      winningNonce: {
        type: DataTypes.STRING(64),
        allowNull: true
      },
      solvedAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false
      }
    }, {
      tableName: 'mining_rounds',
      timestamps: true,
      indexes: [
        { fields: ['currency_id', 'engine_type', 'status'] },
        { fields: ['expires_at'] }
      ]
    });
  }
}

module.exports = MiningRound;
