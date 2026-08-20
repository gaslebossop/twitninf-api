/**
 * Vues effectives utilisées par la monétisation, une fois la part Explorer
 * reformulée en clics et la part publicitaire retirée. `view_count` reste la
 * source de vérité pour les stats créateur et l'algo — cette fonction ne
 * sert qu'au calcul de paie.
 *
 * Un clic Explorer compte double une vue normale — signal plus fort qu'un
 * simple passage dans le mur. Une vue publicitaire, elle, ne rapporte RIEN :
 * l'annonceur l'a déjà payée au CPM ; la payer une seconde fois via
 * `tweetMonetizationService` reviendrait à subventionner sa propre publicité
 * quand l'annonceur est aussi l'auteur du tweet promu.
 *
 * `Math.max(0, ...)` garde contre des compteurs Explorer/pub qui
 * dépasseraient `view_count` par une course entre requêtes concurrentes sur
 * le même tweet.
 */
function computeEffectiveViews({ rawViews = 0, exploreViews = 0, exploreClicks = 0, adViews = 0 } = {}) {
  return Math.max(0, (rawViews || 0) - (exploreViews || 0) - (adViews || 0)) + (exploreClicks || 0) * 2;
}

module.exports = { computeEffectiveViews };
