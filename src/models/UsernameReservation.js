const { DataTypes } = require('sequelize');

/**
 * Pseudo libre retenu par un utilisateur, ou par le système.
 *
 * Deux usages, une seule table parce que c'est le même verrou : « personne
 * d'autre ne peut prendre ce pseudo jusqu'à telle date ».
 *
 * - `user` : réservation payée par un abonné, qui pourra la convertir en
 *   changement de pseudo tant qu'elle court.
 * - `system` : garde-fou posé par la plateforme — le pseudo de repli d'un
 *   vendeur pendant que son annonce est en ligne, ou l'ancien pseudo d'un
 *   compte qui vient d'en changer, protégé le temps que les liens et les
 *   mentions se tassent. Sans ça, le premier venu récupère l'identité d'un
 *   compte connu à la seconde où il la quitte.
 *
 * La disponibilité d'un pseudo se lit donc en deux temps : absent de `users`
 * ET sans réservation active ici.
 */

const UsernameReservation = (sequelize) => sequelize.define('UsernameReservation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  /** Toujours en minuscules : c'est la clé d'unicité. */
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  /** Null pour une réservation posée par la plateforme. */
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  kind: {
    type: DataTypes.ENUM('user', 'system'),
    defaultValue: 'user',
  },
  /** `listing_replacement`, `former_username`, `purchase` — pour l'audit. */
  origin: {
    type: DataTypes.STRING(40),
    allowNull: true,
  },
  price_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: true,
  },
  spend_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  /** Réservation consommée : le pseudo a été effectivement pris. */
  claimed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  released_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'username_reservations',
  timestamps: true,
  underscored: true,
  indexes: [
    // Pas d'unicité stricte sur `username` : une réservation expirée ou
    // libérée doit pouvoir cohabiter avec la suivante. L'unicité réelle est
    // « une seule réservation ACTIVE », que le service tient sous verrou.
    { fields: ['username'] },
    { fields: ['user_id'] },
    { fields: ['expires_at'] },
  ],
});

module.exports = UsernameReservation;
