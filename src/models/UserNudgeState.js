const { DataTypes, Model } = require('sequelize');

/**
 * État de la relance quotidienne, une ligne par utilisateur.
 *
 * Deux choses vivent ici, et elles ont des rythmes très différents :
 *
 *  1. Ce qui est APPRIS — `slots`, les heures où la personne est
 *     habituellement active. Recalculé une fois par nuit par
 *     `activityProfileService`, jamais en cours de journée.
 *  2. Ce qui est OBSERVÉ — les compteurs d'envoi et de fatigue. Écrits à
 *     chaque relance, lus à chaque passage du planificateur.
 *
 * Les garder dans la même ligne évite une jointure sur le chemin chaud du
 * planificateur, qui interroge la table toutes les quinze minutes.
 *
 * ⚠️ `sync()` ne crée pas les index partiels ni les contraintes de cette
 * table (voir la note de `migrate.js`) : le DDL de
 * `src/migrations/2026-08-30-user-nudge-state.sql` doit être joué à la main
 * sur le VPS, sinon la table existe à moitié et le planificateur balaie
 * toute la table à chaque tour.
 */
class UserNudgeState extends Model {
  /**
   * Une pause de fatigue court-elle encore ?
   *
   * Volontairement une méthode et non une colonne calculée : la comparaison
   * doit se faire à l'instant de la décision, pas à l'instant de la lecture.
   */
  isPaused(now = new Date()) {
    return Boolean(this.paused_until && new Date(this.paused_until) > now);
  }

  static initUserNudgeStateModel(sequelize) {
    UserNudgeState.init({
      user_id: {
        type: DataTypes.UUID,
        primaryKey: true,
      },

      /**
       * Les deux meilleures heures apprises, en heure locale d'Europe/Paris,
       * séparées semaine et week-end.
       *
       * Forme : `{ "weekday": [14, 20], "weekend": [16, 23] }`
       *
       * Pourquoi deux jeux et pas sept : avec la volumétrie réelle (36 actifs
       * sur 30 jours), découper par jour de la semaine donnerait des
       * histogrammes de quelques dizaines d'événements — du bruit présenté
       * comme une préférence.
       */
      slots: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: { weekday: [], weekend: [] },
      },

      /**
       * `personal` quand les créneaux viennent des données de la personne,
       * `global` quand ils viennent de l'histogramme de toute la population
       * faute d'assez d'événements. Sert à mesurer séparément l'efficacité
       * des deux, et à savoir qui sortira du démarrage à froid.
       */
      slots_source: {
        type: DataTypes.ENUM('personal', 'global'),
        allowNull: false,
        defaultValue: 'global',
      },

      /** Nombre d'événements ayant servi à l'apprentissage. */
      sample_events: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      slots_computed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      /** Dernière relance envoyée, tous créneaux confondus. */
      last_nudge_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      /**
       * Jour calendaire (Europe/Paris) de `nudges_today`, au format
       * `YYYY-MM-DD`. Sans lui, il faudrait comparer des dates en SQL avec
       * conversion de fuseau à chaque tour du planificateur ; une chaîne
       * comparée à l'égalité coûte moins et se lit dans les journaux.
       */
      nudges_day: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },

      nudges_today: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      /**
       * Relances consécutives sans ouverture dans les deux heures. Remis à
       * zéro dès qu'une ouverture est constatée.
       */
      consecutive_ignored: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      /** Fin de la pause de fatigue. `null` quand la personne est éligible. */
      paused_until: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      /**
       * Tweet de la dernière relance, et l'instant de son envoi. Le couple
       * sert à deux choses : ne pas proposer deux fois le même contenu, et
       * décider si la relance a été ouverte (une session ouverte dans les
       * deux heures qui suivent).
       */
      last_tweet_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },

      /** Total cumulé, pour le suivi. */
      total_sent: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      total_opened: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    }, {
      sequelize,
      modelName: 'UserNudgeState',
      tableName: 'user_nudge_state',
      underscored: true,
      timestamps: true,

      // AUCUN `indexes` ici, délibérément. Les index de cette table sont
      // PARTIELS (`WHERE paused_until IS NULL`), et Sequelize ne sait pas les
      // décrire : il en créerait un second jeu, complet et redondant, sous
      // ses propres noms. Ils vivent donc uniquement dans
      // `migrations/20260830-user-nudge-state.sql`.
      //
      // Ce n'est pas qu'une question de doublon : au premier déploiement, la
      // table appartenait à `postgres` (créée via `sudo -u postgres psql`)
      // alors que l'API se connecte en `admin`. `sync()` a voulu poser son
      // index, s'est pris un « must be owner of table », et le worker a
      // refusé de démarrer — tous les crons avec lui.
    });

    return UserNudgeState;
  }
}

module.exports = UserNudgeState;
