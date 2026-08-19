/**
 * Vues effectives utilisées par la monétisation, une fois la part Explorer
 * reformulée en clics. `view_count` reste la source de vérité pour les
 * stats créateur et l'algo — cette fonction ne sert qu'au calcul de paie.
 *
 * Un clic Explorer compte double une vue normale — signal plus fort qu'un
 * simple passage dans le mur. `Math.max(0, ...)` garde contre un
 * `explore_view_count` qui dépasserait `view_count` par une course entre
 * deux requêtes concurrentes sur le même tweet.
 */
function computeEffectiveViews({ rawViews = 0, exploreViews = 0, exploreClicks = 0 } = {}) {
  return Math.max(0, (rawViews || 0) - (exploreViews || 0)) + (exploreClicks || 0) * 2;
}

module.exports = { computeEffectiveViews };
