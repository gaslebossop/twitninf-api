'use strict';

/**
 * 🧪 Programme beta — une ligne par compte.
 *
 * La ligne porte À LA FOIS la candidature et l'appartenance. Les séparer en
 * deux tables obligerait à les joindre pour répondre à la seule question qui
 * compte à chaque requête — « ce compte est-il membre ? » — et ouvrirait la
 * porte à deux vérités contradictoires sur le même compte.
 *
 * ── Cycle de vie ──
 *
 *   (rien) ──apply──▶ pending ──approve──▶ approved ──revoke──▶ revoked
 *                        │                    │                    │
 *                     reject                leave              (re)apply
 *                        ▼                    ▼                    ▼
 *                    rejected                left               pending
 *
 * `approved` est le SEUL statut pour lequel l'attribut de ciblage `is_beta`
 * vaut vrai (voir `services/featureFlagService.resolveLazyAttributes`).
 *
 * Re-candidater réécrit la ligne existante plutôt que d'en ajouter une : d'où
 * la clé primaire sur `user_id`. On perd l'historique des passages ; la table
 * sert à décider qui est membre aujourd'hui, pas à auditer.
 *
 * ⚠️ Toute écriture de `status` doit purger `feature-flags:ctx:<user_id>` sur
 * Redis — c'est `betaService.invalidateFlagContext` qui s'en charge, et c'est
 * le seul chemin d'écriture autorisé. Écrire ce modèle en direct laisserait
 * un nouveau membre cinq minutes sur l'ancien fil, sans erreur ni log.
 */

const { DataTypes } = require('sequelize');

/** Statuts possibles. L'ordre n'a pas de sens métier, la contrainte SQL le reprend. */
const STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'left'];

/** D'où vient la candidature. Sert à savoir quelle surface amène du monde. */
const SOURCES = ['mobile', 'windows', 'web'];

module.exports = (sequelize) => {
  const BetaMember = sequelize.define(
    'BetaMember',
    {
      user_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
      },

      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        validate: { isIn: [STATUSES] },
      },

      /** Texte libre laissé par le candidat. Facultatif, jamais exigé. */
      motivation: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      source: {
        type: DataTypes.STRING(16),
        allowNull: true,
        validate: { isIn: [[...SOURCES, null]] },
      },

      /** `ios` | `android` | `windows` | `web` — lu sur les en-têtes du client. */
      platform: {
        type: DataTypes.STRING(16),
        allowNull: true,
      },

      app_version: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },

      /**
       * Date de la candidature COURANTE, remise à jour à chaque nouvelle
       * candidature. C'est elle qui ordonne la file d'attente, donc
       * re-candidater après un refus fait repartir en fin de file — voulu.
       */
      applied_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },

      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      reviewed_by: { type: DataTypes.UUID, allowNull: true },
      review_note: { type: DataTypes.TEXT, allowNull: true },

      approved_at: { type: DataTypes.DATE, allowNull: true },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'beta_members',
      timestamps: true,
      underscored: true,
      // Volontairement AUCUN index declare ici. Ceux dont ce modele a besoin
      // sont PARTIELS (`WHERE status = 'pending'` / `= 'approved'`), ce que
      // Sequelize ne sait pas exprimer : les declarer ici ferait poser par
      // `sync()` deux index pleins sur les memes colonnes, qui doublonneraient
      // les partiels sans jamais servir. Ils sont crees par
      // `scripts/autoMigration.js`, avec la contrainte de statut.
    }
  );

  BetaMember.STATUSES = STATUSES;
  BetaMember.SOURCES = SOURCES;

  BetaMember.associate = function associate(models) {
    BetaMember.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    BetaMember.belongsTo(models.User, { foreignKey: 'reviewed_by', as: 'reviewer' });
  };

  /**
   * Ce que l'app et la console reçoivent. Ne contient jamais `reviewed_by` :
   * savoir QUI a refusé une candidature ne regarde pas le candidat, et la
   * console admin lit la ligne complète par ailleurs.
   */
  BetaMember.prototype.toPublicJSON = function toPublicJSON() {
    return {
      status: this.status,
      motivation: this.motivation ?? null,
      applied_at: this.applied_at ? new Date(this.applied_at).toISOString() : null,
      reviewed_at: this.reviewed_at ? new Date(this.reviewed_at).toISOString() : null,
      approved_at: this.approved_at ? new Date(this.approved_at).toISOString() : null,
      revoked_at: this.revoked_at ? new Date(this.revoked_at).toISOString() : null,
    };
  };

  return BetaMember;
};
