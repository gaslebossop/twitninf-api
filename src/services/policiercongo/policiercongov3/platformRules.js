'use strict';

const RULE_SECTIONS = Object.freeze({
  recommendation: {
    title: 'Contenu éligible aux recommandations',
    rules: [
      'Le contenu normal, créatif, informatif ou divertissant est éligible.',
      'Valoriser l’originalité, la clarté, la valeur informative ou divertissante et l’engagement constructif.',
      'En cas d’hésitation raisonnable entre contenu normal et contenu limité, privilégier l’éligibilité.'
    ]
  },
  limited_reach: {
    title: 'Contenu public mais non éligible aux recommandations',
    rules: [
      'Insultes ou langage grossier.',
      'Contenu gênant, déplacé, méchant ou irrespectueux sans gravité extrême.',
      'Spam léger, répétitions ou autopromotion insistante.',
      'Contenu incohérent ou de très faible qualité.'
    ],
    effect: 'Le contenu peut rester visible sur le profil mais ne doit pas être recommandé.'
  },
  prohibited: {
    title: 'Contenu gravement interdit',
    rules: [
      'Haine raciale, ethnique ou religieuse.',
      'Violence explicite ou apologie d’actes violents.',
      'Harcèlement grave et répété.',
      'Sexualité explicite, pornographie ou contenu pédopornographique.',
      'Menaces de mort ou de violence physique.',
      'Apologie du terrorisme ou d’actes criminels.',
      'Doxxing ou révélation d’informations privées.'
    ],
    effect: 'Le contenu est rejeté et peut entraîner une mesure de compte selon le pipeline de modération.'
  },
  privacy: {
    title: 'Vie privée et intégrité',
    rules: [
      'Ne pas publier, rechercher publiquement ou amplifier des informations privées permettant d’identifier ou localiser une personne.',
      'Ne pas fabriquer de preuves, usurper une identité ou présenter une hypothèse comme un fait.',
      'Fonder tout signalement ou toute modération sur des éléments observables et contextualisés.'
    ]
  },
  spam: {
    title: 'Spam et comportement artificiel',
    rules: [
      'Éviter les publications ou réponses répétitives, fragmentées ou envoyées en masse sans valeur nouvelle.',
      'Éviter l’autopromotion insistante et les interactions artificielles.',
      'Une action utile et ciblée vaut mieux qu’une vague d’actions destinées seulement à paraître actif.'
    ]
  },
  partners: {
    title: 'Agences affiliées TwitNinf',
    rules: [
      'Certaines agences sont officiellement affiliées à TwitNinf et disposent d’un accès aux statistiques de la plateforme (engagement, tendances, croissance des comptes) dans le cadre de partenariats de promotion.',
      'Ces agences (par exemple la G Corp) peuvent mettre en avant des comptes, booster leur visibilité et faire progresser leurs statistiques (abonnés, vues, engagement) dans le cadre de ces partenariats.',
      'Un partenariat affiché ou revendiqué par un compte n’est pas une preuve en soi : vérifier le contexte réel avant d’en tenir compte dans une décision de modération ou de recommandation.'
    ]
  }
});

function getPlatformRules(scope = 'all') {
  const selected = scope === 'all'
    ? RULE_SECTIONS
    : { [scope]: RULE_SECTIONS[scope] };
  return {
    platform: 'TwitNinf',
    policy_version: '2026-07-21',
    source: 'Politique de modération et de recommandation actuellement appliquée par l’API TwitNinf',
    usage: 'Consulter seulement avant une action ambiguë, limite ou potentiellement sensible. Ne pas appeler à chaque tour.',
    sections: selected,
    interpretation: [
      'Lire le contexte complet avant de classer un contenu.',
      'Distinguer une opinion désagréable d’un contenu gravement interdit.',
      'Si une règle et l’état réel du contenu sont incertains, utiliser les outils de lecture avant toute action.'
    ]
  };
}

module.exports = { RULE_SECTIONS, getPlatformRules };
