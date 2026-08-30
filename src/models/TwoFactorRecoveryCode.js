const { DataTypes, Model } = require('sequelize');

/**
 * Codes de secours de la double authentification.
 *
 * Sans eux, un téléphone perdu = un compte perdu : ni le code par e-mail ni
 * l'application ne peuvent plus répondre, et il ne reste qu'une intervention
 * manuelle en base. Ils sont rendus UNE seule fois, à l'activation.
 *
 * Seul le condensé est stocké — un code de secours est un mot de passe.
 * `used_at` plutôt qu'une suppression : savoir qu'un code a servi, et quand,
 * a une valeur pour l'utilisateur qui enquête sur un accès suspect.
 */
class TwoFactorRecoveryCode extends Model {
  static initTwoFactorRecoveryCodeModel(sequelize) {
    TwoFactorRecoveryCode.init({
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false },
      code_hash: { type: DataTypes.TEXT, allowNull: false },
      used_at: { type: DataTypes.DATE, allowNull: true },
    }, {
      sequelize,
      modelName: 'TwoFactorRecoveryCode',
      tableName: 'two_factor_recovery_codes',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['user_id'] }],
    });
    return TwoFactorRecoveryCode;
  }
}

module.exports = TwoFactorRecoveryCode;
