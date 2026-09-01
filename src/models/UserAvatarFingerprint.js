const { DataTypes, Model } = require('sequelize');

/**
 * Empreinte perceptuelle de la photo de profil d'un compte.
 *
 * ── Pourquoi une TABLE et pas des colonnes sur `users` ───────────────────
 *
 * `syncDatabase()` cree les tables manquantes mais tourne en `alter: false` :
 * il **n'ajoute jamais une colonne a une table existante**. Une colonne
 * ajoutee au modele `User` n'atteindrait donc jamais la base de production,
 * pendant que Sequelize la selectionnerait dans chaque `findAll` — et tout
 * acces a `users` mourrait sur `column "..." does not exist`. Une table neuve,
 * elle, apparait toute seule.
 *
 * ── Ce que ca stocke ─────────────────────────────────────────────────────
 *
 * `avatar_url` sert de temoin de fraicheur : quand un compte change de photo,
 * l'URL change, et l'empreinte est recalculee. On ne garde qu'une ligne par
 * compte — l'historique des anciennes photos n'aiderait pas a decider si un
 * compte en usurpe un autre AUJOURD'HUI.
 *
 * `unreadable` distingue « pas encore calcule » de « impossible a calculer ».
 * Sans lui, une image corrompue serait retentee a chaque balayage horaire, pour
 * toujours echouer — un cout permanent pour un resultat connu d'avance.
 */
class UserAvatarFingerprint extends Model {}

const userAvatarFingerprintSchema = {
    user_id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },

    /** URL de la photo au moment du calcul. Change => recalcul. */
    avatar_url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    /**
     * dHash 64 bits en hexadecimal (16 caracteres).
     *
     * Indexee : la recherche de candidats commence par une egalite exacte,
     * qui attrape le cas le plus frequent — la photo reprise telle quelle —
     * sans parcourir toute la table. Les quasi-copies sont ensuite filtrees
     * par distance de Hamming en memoire, sur un vivier deja restreint.
     */
    dhash: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },

    /** aHash 64 bits. Se trompe differemment de la dHash. */
    ahash: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },

    /**
     * Empreintes de l'image entiere puis de ses centres a 90/80/70 %.
     *
     * C'est ce qui rend le RECADRAGE detectable : si B est un recadrage de A,
     * le niveau correspondant de A ressemble a B entiere. Mesure sur de vrais
     * avatars : un recadrage a 90 % passe d'une distance de 14 a 2.
     */
    pyramid: {
      type: DataTypes.JSONB,
      allowNull: true,
    },

    /**
     * Toutes les tranches de 4 hex de tous les niveaux (16 entrees).
     *
     * Sert UNIQUEMENT a la preselection : deux empreintes proches partagent
     * forcement une tranche (principe des tiroirs), donc un simple recouvrement
     * de tableaux ramene le vivier a quelques lignes, que la distance de
     * Hamming departage ensuite en memoire.
     *
     * Sans ca, un compte a la photo reprise mais au pseudo different n'etait
     * jamais candidat : le score, aussi bon soit-il, ne tournait pas sur lui.
     */
    bands: {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: true,
    },

    /**
     * Histogramme couleur 4x4x4 normalise (64 valeurs).
     *
     * Tolerant au recadrage, mais mauvais discriminant : ne sert qu'a
     * renforcer un faisceau, jamais a declencher seul une alerte.
     */
    color: {
      type: DataTypes.JSONB,
      allowNull: true,
    },

    /** L'image existe mais n'a pas pu etre lue. Evite de la retenter sans fin. */
    unreadable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    computed_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
};

const modelOptions = {
  modelName: 'UserAvatarFingerprint',
  tableName: 'user_avatar_fingerprints',
  timestamps: false,
  indexes: [
    { fields: ['dhash'] },
    { fields: ['computed_at'] },
  ],
};

function initUserAvatarFingerprintModel(sequelize) {
  UserAvatarFingerprint.init(userAvatarFingerprintSchema, { ...modelOptions, sequelize });
}

module.exports = UserAvatarFingerprint;
module.exports.initUserAvatarFingerprintModel = initUserAvatarFingerprintModel;
module.exports.userAvatarFingerprintSchema = userAvatarFingerprintSchema;
module.exports.modelOptions = modelOptions;
