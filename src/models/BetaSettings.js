'use strict';

/**
 * 🧪 Réglages du programme beta — singleton.
 *
 * Une seule ligne, `id = 1`, garantie par une contrainte SQL plutôt que par
 * une convention : un second jeu de réglages créé par erreur donnerait deux
 * réponses différentes à « les candidatures sont-elles ouvertes ? » selon
 * l'ordre de lecture.
 *
 * `capacity` ne borne QUE l'approbation, jamais la candidature. Une file qui
 * continue d'accepter des candidats quand les places sont prises est normale ;
 * un formulaire qui refuse sans le dire ne l'est pas.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const BetaSettings = sequelize.define(
    'BetaSettings',
    {
      id: {
        type: DataTypes.SMALLINT,
        primaryKey: true,
        defaultValue: 1,
        validate: { isIn: [[1]] },
      },

      /** Accepte-t-on de nouvelles candidatures ? N'affecte pas les membres. */
      is_open: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },

      /** Nombre maximum de membres `approved`. `null` = illimité. */
      capacity: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 0 },
      },

      headline: {
        type: DataTypes.STRING(160),
        allowNull: false,
        defaultValue: 'La beta TwitNinf',
      },

      /** Texte de la vitrine publique. Markdown non interprété : du texte brut. */
      pitch: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    {
      tableName: 'beta_settings',
      timestamps: true,
      createdAt: false,
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  BetaSettings.associate = function associate(models) {
    BetaSettings.belongsTo(models.User, { foreignKey: 'updated_by', as: 'updater' });
  };

  /**
   * Lecture du singleton, créé à la volée s'il manque.
   *
   * `findOrCreate` plutôt qu'un `findByPk` qui pourrait rendre `null` : tout
   * appelant en aval suppose des réglages présents, et un `null` ici
   * ferait tomber la vitrine publique au lieu de la montrer ouverte.
   */
  BetaSettings.load = async function load() {
    const [settings] = await BetaSettings.findOrCreate({
      where: { id: 1 },
      defaults: { id: 1 },
    });
    return settings;
  };

  return BetaSettings;
};
