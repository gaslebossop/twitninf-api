/**
 * 📋 Modèle pour les demandes de vérification
 * Gère les demandes de vérification des utilisateurs
 */

const { DataTypes } = require('sequelize');
const logger = require('../utils/logger');

module.exports = (sequelize) => {
  const VerificationRequest = sequelize.define('VerificationRequest', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'under_review'),
      defaultValue: 'pending',
      allowNull: false
    },
    request_type: {
      type: DataTypes.ENUM('individual', 'brand', 'organization', 'celebrity'),
      allowNull: false,
      defaultValue: 'individual'
    },
    // Informations du formulaire
    form_data: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {}
    },
    // Données analysées par Gemini
    analysis_data: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },
    // Réponse de Gemini
    gemini_response: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },
    // Raison d'approbation/rejet
    reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    // Admin qui a traité la demande
    processed_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    // Date de traitement
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    // Métadonnées supplémentaires
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    tableName: 'verification_requests',
    timestamps: true,
    indexes: [
      {
        fields: ['user_id']
      },
      {
        fields: ['status']
      },
      {
        fields: ['request_type']
      },
      {
        fields: ['created_at']
      }
    ],
    hooks: {
      beforeCreate: (verificationRequest) => {
        logger.info(`📋 Nouvelle demande de vérification créée pour l'utilisateur ${verificationRequest.user_id}`);
      },
      beforeUpdate: (verificationRequest) => {
        if (verificationRequest.changed('status')) {
          logger.info(`📋 Statut de vérification mis à jour pour ${verificationRequest.user_id}: ${verificationRequest.status}`);
        }
      }
    }
  });

  // Associations
  VerificationRequest.associate = (models) => {
    VerificationRequest.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user'
    });
    
    VerificationRequest.belongsTo(models.User, {
      foreignKey: 'processed_by',
      as: 'processor'
    });
  };

  // Méthodes statiques
  VerificationRequest.createVerificationRequest = async (userId, formData, requestType = 'individual') => {
    try {
      const verificationRequest = await VerificationRequest.create({
        user_id: userId,
        form_data: formData,
        request_type: requestType,
        status: 'pending'
      });

      logger.info(`✅ Demande de vérification créée: ${verificationRequest.id}`);
      return verificationRequest;
    } catch (error) {
      logger.error('❌ Erreur lors de la création de la demande de vérification:', error);
      throw error;
    }
  };

  // Méthodes d'instance
  VerificationRequest.prototype.approve = async function(processedBy, reason = null) {
    try {
      await this.update({
        status: 'approved',
        reason: reason,
        processed_by: processedBy,
        processed_at: new Date()
      });

      // Mettre à jour le statut de vérification de l'utilisateur
      await this.sequelize.models.User.update(
        { verified: true },
        { where: { id: this.user_id } }
      );

      logger.info(`✅ Demande de vérification approuvée: ${this.id}`);
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'approbation de la vérification:', error);
      throw error;
    }
  };

  VerificationRequest.prototype.reject = async function(processedBy, reason = null) {
    try {
      await this.update({
        status: 'rejected',
        reason: reason,
        processed_by: processedBy,
        processed_at: new Date()
      });

      logger.info(`❌ Demande de vérification rejetée: ${this.id}`);
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors du rejet de la vérification:', error);
      throw error;
    }
  };

  // Méthode pour obtenir les statistiques
  VerificationRequest.getStats = async () => {
    try {
      const stats = await VerificationRequest.findAll({
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['status'],
        raw: true
      });

      return stats.reduce((acc, stat) => {
        acc[stat.status] = parseInt(stat.count);
        return acc;
      }, {});
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des stats de vérification:', error);
      return {};
    }
  };

  return VerificationRequest;
};
