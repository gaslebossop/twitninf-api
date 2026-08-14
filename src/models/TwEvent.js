/**
 * Événement unifié : une période, une direction artistique, des
 * fonctionnalités, des quêtes.
 *
 * ── Ce qu'il remplace ─────────────────────────────────────────────────────
 * Trois tables décrivaient le même objet sans se connaître : `events` (les
 * couleurs), `functional_events` (les bascules par page) et `user_challenges`
 * (les quêtes). Rien ne les reliait qu'un `event_slug` recopié à la main, si
 * bien qu'un événement pouvait avoir sa DA active et ses quêtes expirées sans
 * que rien ne le signale.
 *
 * ── Pourquoi les quêtes sont en JSONB ─────────────────────────────────────
 * Ce sont des DÉFINITIONS, pas des données vivantes : lues en bloc avec
 * l'événement, jamais interrogées séparément, jamais modifiées après le
 * lancement. Une table séparée n'apporterait qu'une jointure de plus sur le
 * chemin le plus chaud. L'état par compte, lui, vit dans `tw_quest_claims`.
 *
 * ── Pourquoi `art` est une clé et non des couleurs ────────────────────────
 * L'app résout `art: 'birthday'` vers une direction artistique dessinée dans
 * son code. L'ancienne table stockait douze codes hexadécimaux saisis dans un
 * formulaire d'admin — c'est ainsi qu'on obtient du texte gris sur fond violet
 * à 2,8:1 de contraste. Une clé inconnue de l'app retombe sur l'habillage
 * ordinaire, donc un événement peut être créé avant que sa DA ne soit livrée.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TwEvent = sequelize.define('TwEvent', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    slug: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      comment: 'Identifiant stable de l\'événement (ex: birthday2026)',
    },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },

    starts_at: { type: DataTypes.DATE, allowNull: false },
    ends_at: { type: DataTypes.DATE, allowNull: false },

    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Fait foi. Les dates ne servent qu\'à l\'affichage et au tri.',
    },
    priority: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Départage deux événements actifs. Le plus haut gagne.',
    },

    art: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'none',
      comment: 'Clé de DA résolue côté app (none, birthday…)',
    },
    features: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'hub, banner, intro, skinApp, earnMultiplier, dailyGift',
    },
    quests: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Définitions des quêtes. Voir docs/EVENTS_API.md côté mobile.',
    },
    banner_message: { type: DataTypes.STRING(200), allowNull: true },
  }, {
    tableName: 'tw_events',
    timestamps: true,
    underscored: true,
    indexes: [
      // L'index du chemin chaud : « l'événement actif le plus prioritaire »,
      // interrogé à chaque ouverture de l'app par chaque compte.
      { fields: ['is_active', 'priority'] },
      { fields: ['slug'], unique: true },
    ],
  });

  /**
   * L'événement en cours, ou `null`.
   *
   * `null` est une réponse NORMALE : onze mois sur douze il ne se passe rien,
   * et c'est le cas que tout le reste doit savoir traiter en premier.
   *
   * On ne filtre PAS sur les dates ici. `is_active` fait foi : un événement
   * dont la fenêtre est passée mais qu'on laisse allumé reste servi, ce qui
   * laisse le temps de venir réclamer ce qu'on a gagné.
   */
  TwEvent.getCurrent = async function () {
    return this.findOne({
      where: { is_active: true },
      order: [['priority', 'DESC'], ['starts_at', 'DESC']],
    });
  };

  return TwEvent;
};
