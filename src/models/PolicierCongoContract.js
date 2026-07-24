const { DataTypes } = require('sequelize');

class PolicierCongoContract {
  static initPolicierCongoContractModel(sequelize) {
    return sequelize.define('PolicierCongoContract', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      creatorUserId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'creator_user_id',
        comment: 'Utilisateur vérifié qui a créé le contrat via /createcontrat'
      },
      conversationId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'conversation_id',
        comment: 'DM dans lequel le contrat a été créé — sert à capturer les messages suivants'
      },
      contractText: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'contract_text'
      },
      status: {
        type: DataTypes.ENUM('pending', 'accepted', 'refused'),
        allowNull: false,
        defaultValue: 'pending'
      },
      messages: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Copie des messages échangés entre création et décision (accepté/refusé) — sert de preuve/termes du contrat'
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'decided_at'
      },
      decisionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'decision_reason'
      }
    }, {
      tableName: 'policiercongo_contracts',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['creator_user_id'] },
        { fields: ['conversation_id'] },
        { fields: ['status'] }
      ]
    });
  }
}

module.exports = PolicierCongoContract;
