/**
 * Domaines d'avertissement du moteur Rust (`shadowban::StrikePolicy`), et leur
 * correspondance avec la taxonomie de signalement de l'API (`reportCategories.js`).
 *
 * Les deux taxonomies ne se recouvrent pas exactement — le moteur Rust note 8
 * domaines calibrés sur la nuisance ALGORITHMIQUE (à quelle vitesse fermer une
 * surface), le signalement note 11 catégories calibrées sur la nuisance perçue
 * par un utilisateur. Le mapping ci-dessous est une approximation assumée :
 * mieux vaut un avertissement dans le domaine le plus proche que pas
 * d'avertissement du tout.
 */

const STRIKE_POLICIES = [
  'spam',
  'engagement_bait',
  'unoriginal',
  'misinformation',
  'harassment',
  'adult_content',
  'hateful_conduct',
  'violent_threat',
];

/**
 * Catégorie de signalement (`reportCategories.js`) → domaine d'avertissement.
 *
 * Trois choix qui méritent d'être expliqués :
 * - `child_safety` → `violent_threat` : c'est le domaine le plus sévère
 *   disponible (Ghosted dès le premier fait), pas parce que la nuisance est
 *   de même nature qu'une menace, mais parce qu'aucun domaine dédié n'existe
 *   et que c'est la seule marche assez haute.
 * - `self_harm` → `hateful_conduct` : sévère (Suppressed dès 2 faits) sans
 *   être aussi radical que `violent_threat` — le signalement déclenche par
 *   ailleurs des ressources d'aide au signaleur (voir `reportCategories.js`),
 *   l'objectif n'est pas punitif au même titre qu'une vraie menace.
 * - `illegal`, `privacy`, `impersonation` n'ont pas d'équivalent direct :
 *   rattachés au domaine le plus proche par nature (respectivement nuisance
 *   sérieuse non violente, harcèlement ciblé, contenu non original).
 */
const CATEGORY_TO_STRIKE_POLICY = {
  spam: 'spam',
  harassment: 'harassment',
  hate_speech: 'hateful_conduct',
  violence: 'violent_threat',
  sexual_content: 'adult_content',
  child_safety: 'violent_threat',
  self_harm: 'hateful_conduct',
  impersonation: 'unoriginal',
  privacy: 'harassment',
  misinformation: 'misinformation',
  illegal: 'hateful_conduct',
  other: 'spam',
};

const isStrikePolicy = (p) => STRIKE_POLICIES.includes(p);

/** Domaine d'avertissement pour une catégorie de signalement, `null` si inconnue. */
function strikePolicyForCategory(category) {
  return CATEGORY_TO_STRIKE_POLICY[category] || null;
}

module.exports = {
  STRIKE_POLICIES,
  CATEGORY_TO_STRIKE_POLICY,
  isStrikePolicy,
  strikePolicyForCategory,
};
