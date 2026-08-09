/**
 * Parametres de l'etape d'abonnements de l'inscription.
 *
 * Source unique : la validation de la route, le profil renvoye au client et
 * l'ecran mobile doivent exiger le meme nombre. Deux valeurs qui divergent
 * donnent un ecran qui se debloque a 3 mais un serveur qui refuse a 3.
 */

/**
 * Abonnements exiges pour cloturer l'inscription.
 *
 * Ils sont l'unique signal exploitable au demarrage a froid du recommandeur :
 * sans eux, ni like, ni auteur favori, ni heure d'activite, donc un fil
 * purement generique. Voir COLD_START_FOLLOW_BOOST_MAX cote Rust.
 */
const MIN_ONBOARDING_FOLLOWS = 3;

/** Nombre de comptes proposes a l'ecran, pour laisser un vrai choix. */
const ONBOARDING_SUGGESTION_COUNT = 12;

module.exports = { MIN_ONBOARDING_FOLLOWS, ONBOARDING_SUGGESTION_COUNT };
