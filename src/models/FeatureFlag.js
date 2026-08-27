'use strict';

/**
 * 🚩 Drapeau de fonctionnalité (feature flag).
 *
 * Une ligne = une fonctionnalité qu'on peut allumer sans redéployer, pour
 * tout le monde, pour un pourcentage du trafic, ou pour un groupe défini par
 * des attributs (« les créateurs certifiés sur iOS ≥ 1.3.0 »).
 *
 * ── Ordre d'évaluation (le même partout : API, mobile, admin) ──
 *   1. `archived_at` non nul, ou `enabled = false`  → OFF (coupe-circuit).
 *   2. Hors de la fenêtre [start_at, end_at]        → OFF.
 *   3. `blocklist` contient l'unité                 → OFF.
 *   4. `allowlist` contient l'unité                 → ON (variante par défaut).
 *   5. Premier segment de `rules` dont TOUTES les conditions passent :
 *      son propre `percentage` décide, sa `variant` est servie.
 *   6. Sinon, `rollout_percentage` global décide.
 *
 * ── Pourquoi le tirage n'est pas aléatoire ──
 * Le bucket vient d'un hash de `${key}:${salt}:${unité}`, jamais de
 * `Math.random()`. Conséquences voulues :
 *   - un utilisateur qui relance l'app reste du même côté ;
 *   - passer de 10 % à 20 % n'enlève la fonctionnalité à personne : les
 *     buckets 0–999 restent inclus quand la borne monte à 1999 ;
 *   - deux drapeaux à 10 % ne touchent pas les mêmes gens (la clé est dans
 *     le hash), donc les tests ne se contaminent pas ;
 *   - le serveur, l'app et l'écran de simulation calculent le même bucket.
 * Changer `salt` est le seul moyen de rebattre les cartes — c'est explicite.
 */

const { DataTypes } = require('sequelize');

/** Unités de découpage possibles pour le tirage progressif. */
const BUCKET_UNITS = ['user', 'device', 'session'];

/** Types d'audience. Source de vérité : `services/featureFlagEvaluator.js`. */
const AUDIENCES = ['rollout', 'beta'];

module.exports = (sequelize) => {
  const FeatureFlag = sequelize.define(
    'FeatureFlag',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },

      /**
       * Identifiant utilisé DANS LE CODE (`useFlag('feed.new_ranker')`).
       * Immuable en pratique : le renommer casse tous les appelants, et
       * change le hash, donc redistribue les buckets.
       */
      key: {
        type: DataTypes.STRING(120),
        allowNull: false,
        unique: true,
        validate: {
          is: {
            args: /^[a-z0-9]+([._-][a-z0-9]+)*$/,
            msg: 'La clé doit être en minuscules, séparée par . _ ou - (ex: feed.new_ranker)',
          },
        },
      },

      name: {
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: 'Nom lisible affiché dans l\'écran d\'administration',
      },

      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'À quoi sert la fonctionnalité, et quand on pourra retirer le drapeau',
      },

      /**
       * Coupe-circuit. `false` éteint la fonctionnalité pour tout le monde,
       * y compris l'allowlist : c'est le bouton qu'on presse quand ça brûle.
       */
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      /**
       * Type d'audience — QUI la fonctionnalité vise, par nature.
       *
       * `rollout` (défaut) : un pourcentage du trafic, affiné par des segments.
       * `beta` : les membres du programme beta, et personne d'autre.
       *   `rollout_percentage` n'est alors PAS consulté — c'est ce qui rend la
       *   fuite hors de la beta impossible par une montée de palier.
       *
       * Voir `AUDIENCES` dans `services/featureFlagEvaluator.js`.
       */
      audience: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'rollout',
        validate: { isIn: [AUDIENCES] },
      },

      /**
       * Palier de déploiement global, en pourcentage (0 à 100).
       * Ignoré quand `audience = 'beta'`.
       */
      rollout_percentage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: { min: 0, max: 100 },
      },

      /**
       * Segments ciblés, évalués DANS L'ORDRE — le premier qui matche gagne.
       * [{ id, label, percentage, variant, conditions: [{ attribute, operator, value }] }]
       */
      rules: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },

      /**
       * Variantes pour un test A/B. Vide = drapeau booléen (`on` / `off`).
       * [{ key, weight, payload }] — les poids sont relatifs, pas forcément /100.
       */
      variants: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },

      /** Identifiants ou pseudos toujours servis (testeurs internes). */
      allowlist: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },

      /** Identifiants ou pseudos jamais servis. Prime sur tout le reste. */
      blocklist: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },

      /**
       * Ce sur quoi porte le tirage. `device` sert aux fonctionnalités
       * visibles avant connexion : sans compte, il n'y a pas d'identifiant
       * utilisateur stable sur lequel hacher.
       */
      bucket_by: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'user',
        validate: { isIn: [BUCKET_UNITS] },
      },

      /**
       * Sel du hash. Le modifier redistribue TOUS les buckets du drapeau :
       * utile pour relancer un test propre sur une population neuve, jamais
       * à faire pendant un déploiement en cours.
       */
      salt: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'v1',
      },

      /**
       * Montée automatique du palier — « l'autoscaler du drapeau ».
       *
       * À ne pas confondre avec `deploy/twitninf-autoscaler.py`, qui ajoute
       * des répliques web selon la charge. Ici on fait monter une AUDIENCE,
       * pas de la capacité.
       *
       * Forme (voir `services/featureFlagAutoRollout.js`) :
       *   {
       *     enabled: bool,
       *     steps: number[],          // échelle des paliers successifs
       *     interval_minutes: number, // temps d'observation entre deux crans
       *     next_at: ISO|null,        // prochaine avance
       *     started_at: ISO,
       *     last_step_at: ISO|null,
       *     armed_by: uuid|null,
       *     halted_at: ISO|null,
       *     halted_reason: string|null, // flag_off | manual_override | ...
       *     completed_at: ISO|null,     // dernier cran atteint
       *   }
       *
       * `null` = aucune montée automatique, le palier ne bouge qu'à la main.
       * Un plan arrêté n'est jamais repris seul : il faut le réarmer.
       */
      auto_rollout: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null,
      },

      /** Charge utile renvoyée quand le drapeau est ON sans variante. */
      payload: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null,
      },

      start_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Avant cette date, le drapeau reste OFF même activé',
      },

      end_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Après cette date, le drapeau repasse OFF tout seul',
      },

      /**
       * Un drapeau archivé n'est plus évalué et disparaît de la liste par
       * défaut. On archive plutôt que de supprimer : la clé reste réservée
       * tant que du code peut encore l'interroger.
       */
      archived_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
    },
    {
      tableName: 'feature_flags',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['key'], unique: true },
        { fields: ['archived_at'] },
        { fields: ['enabled', 'archived_at'] },
      ],
    }
  );

  FeatureFlag.BUCKET_UNITS = BUCKET_UNITS;
  FeatureFlag.AUDIENCES = AUDIENCES;

  FeatureFlag.associate = function associate(models) {
    FeatureFlag.belongsTo(models.User, { foreignKey: 'created_by', as: 'creator' });
    FeatureFlag.belongsTo(models.User, { foreignKey: 'updated_by', as: 'updater' });
  };

  /**
   * Forme minimale envoyée au moteur d'évaluation. Volontairement pauvre :
   * c'est elle qui transite par Redis et qui est relue à chaque requête, donc
   * ni horodatages de création, ni jointures d'auteur.
   */
  FeatureFlag.prototype.toDefinition = function toDefinition() {
    return {
      key: this.key,
      enabled: this.enabled,
      audience: this.audience || 'rollout',
      rollout_percentage: this.rollout_percentage,
      rules: this.rules || [],
      variants: this.variants || [],
      allowlist: this.allowlist || [],
      blocklist: this.blocklist || [],
      bucket_by: this.bucket_by,
      salt: this.salt,
      payload: this.payload ?? null,
      start_at: this.start_at ? new Date(this.start_at).toISOString() : null,
      end_at: this.end_at ? new Date(this.end_at).toISOString() : null,
      archived_at: this.archived_at ? new Date(this.archived_at).toISOString() : null,
    };
  };

  return FeatureFlag;
};
