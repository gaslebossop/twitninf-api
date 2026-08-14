/**
 * Les gestes que seul le client peut constater.
 *
 * ── Pourquoi cette table existe ───────────────────────────────────────────
 * La quasi-totalité des quêtes se mesure côté serveur : il voit passer les
 * tweets, les likes, les virements. Restent celles qui portent sur la
 * NAVIGATION — « passe voir la Carte NF », « ouvre le Studio créateur » —
 * totalement invisibles depuis l'API.
 *
 * Le client les signale donc. Mais un signal client n'est pas une preuve :
 *
 *  1. `idempotency_key` est UNIQUE en base. Un écran remonté deux fois, une
 *     reprise réseau ou un rejeu manuel comptent une seule fois. La contrainte
 *     est en base et pas dans le code, parce que deux requêtes simultanées
 *     passeraient au travers d'un contrôle applicatif — et c'est précisément
 *     ce que tente quelqu'un qui veut gonfler un compteur.
 *  2. Un signal N'ACCORDE JAMAIS RIEN. Il incrémente un compteur ; c'est la
 *     réclamation qui donne, après re-vérification.
 *  3. Le nombre de signaux distincts est plafonné par le `goal` de la quête au
 *     moment du comptage : en semer mille n'amène pas plus loin que six.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TwQuestSignal = sequelize.define('TwQuestSignal', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    event_slug: { type: DataTypes.STRING(64), allowNull: false },
    quest_id: { type: DataTypes.STRING(64), allowNull: false },
    idempotency_key: {
      type: DataTypes.STRING(160),
      allowNull: false,
      comment: 'Fournie par le client, unique par compte. Voir l\'en-tête.',
    },
  }, {
    tableName: 'tw_quest_signals',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['user_id', 'idempotency_key'],
        unique: true,
        name: 'tw_quest_signals_unique',
      },
      // Le comptage « combien de signaux distincts sur cette quête ».
      { fields: ['user_id', 'event_slug', 'quest_id'] },
    ],
  });

  return TwQuestSignal;
};
