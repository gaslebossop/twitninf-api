const { DataTypes } = require('sequelize');

/**
 * Un tweet signalé, anonymisé, soumis au jugement de la communauté (BÊTA).
 *
 * ⚠ Ce que cette table NE contient PAS est aussi important que ce qu'elle
 * contient : ni le texte d'origine, ni l'id de l'auteur, ni celui des
 * signaleurs. Les votants ne doivent pas pouvoir remonter à la personne — sinon
 * la revue devient un outil de brigade, l'inverse exact de ce qu'on veut. Le
 * lien vers le tweet réel n'existe que par `tweet_id`, réservé au traitement
 * côté modération et jamais renvoyé au votant.
 */
const CommunityReviewItem = (sequelize) => sequelize.define('CommunityReviewItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true
  },
  /**
   * Auteur du tweet. Sert UNIQUEMENT à empêcher quelqu'un de juger son propre
   * contenu — jamais exposé par les routes de vote.
   */
  author_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  /** Texte réécrit par le LLM : identités, lieux et pseudos remplacés. */
  anonymized_content: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /**
   * `pending` tant que le LLM n'a pas répondu, `failed` s'il a échoué.
   * Un item n'est proposé au vote qu'en `done` : plutôt ne rien montrer que
   * montrer un texte encore nominatif.
   */
  anonymization_status: {
    type: DataTypes.ENUM('pending', 'done', 'failed'),
    defaultValue: 'pending'
  },
  /** Nombre de passages remplacés — affiché au votant pour qu'il sache. */
  redactions: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  /** Le tweet portait-il des médias ? Ils ne sont jamais montrés (non anonymisables). */
  had_media: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  /** Motifs de signalement, dédupliqués, sans le moindre id de signaleur. */
  report_reasons: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  report_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  votes_compliant: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  votes_violation: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  status: {
    type: DataTypes.ENUM('open', 'closed'),
    defaultValue: 'open'
  },
  /**
   * Verdict communautaire, dès qu'un camp atteint le seuil d'accord (3 votes).
   * `violation` déclenche l'exécution d'une sanction (voir `sanction`) ;
   * `compliant` ferme juste l'item et classe les signalements liés.
   */
  verdict: {
    type: DataTypes.ENUM('compliant', 'violation'),
    allowNull: true
  },
  /**
   * Sanction réellement EXÉCUTÉE quand `verdict = 'violation'` — pas une
   * simple recommandation. Trois sorties sont possibles : `delete`, `suspend`
   * (durée exacte dans `adjudication.duration_days`) ou `ban_definitif`.
   *
   * ⚠ Ce n'est PLUS le jury qui la calcule. Les votants ne répondent plus à
   * aucune question de gravité : ils tranchent conforme / non conforme, et ce
   * verdict est final. Le modèle arbitre choisit uniquement la sanction sur le
   * texte anonymisé (voir `communityReviewAdjudicator`). Reste `null` tant que
   * l'arbitrage n'est pas rendu — l'appel au modèle est trop lent pour tenir
   * dans la transaction du vote.
   *
   * Volontairement en TEXT et non en ENUM : la colonne l'est déjà en base, et
   * un ENUM Sequelize par-dessus n'aurait fait qu'ajouter une validation
   * cliente à tenir en phase avec le barème à chaque nouveau palier.
   */
  sanction: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /**
   * Où en est l'arbitrage du modèle : `null` tant que le jury n'a pas conclu à
   * `violation`, puis `pending` → `done`. `failed` veut dire que le modèle n'a
   * pas répondu exploitablement — le repli (`delete`, le minimum obligatoire)
   * a quand même été appliqué, l'item n'attend rien.
   */
  adjudication_status: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  /**
   * Trace de la décision : `{ model, sanction, motif, raison, at, fallback }`.
   * C'est la seule chose qui explique POURQUOI ce palier-là à un modérateur qui
   * rouvrirait le dossier — sans elle, la sanction serait un chiffre sorti de
   * nulle part.
   */
  adjudication: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  closed_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'community_review_items',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['status'] },
    { fields: ['anonymization_status'] },
    { unique: true, fields: ['tweet_id'] }
  ]
});

module.exports = CommunityReviewItem;
