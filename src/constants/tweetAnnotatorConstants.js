'use strict';

const THEMES = [
  { id: 'humour', label: 'Humour' },
  { id: 'education', label: 'Éducation' },
  { id: 'actualite', label: 'Actualité / Info' },
  { id: 'politique', label: 'Politique' },
  { id: 'sport', label: 'Sport' },
  { id: 'musique_culture', label: 'Musique / Culture' },
  { id: 'cinema_series', label: 'Cinéma / Séries' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'sciences', label: 'Sciences' },
  { id: 'business_argent', label: 'Business / Argent' },
  { id: 'sante', label: 'Santé' },
  { id: 'relations_vie_perso', label: 'Relations / Vie perso' },
  { id: 'mode_beaute', label: 'Mode / Beauté' },
  { id: 'voyage', label: 'Voyage' },
  { id: 'nourriture', label: 'Nourriture' },
  { id: 'spam_pub', label: 'Spam / Pub' },
  { id: 'autre', label: 'Autre' },
];

const VIOLATION_RULES = [
  { id: 'spam_publicite', label: 'Spam / publicité' },
  { id: 'harcelement_insultes', label: 'Harcèlement / insultes' },
  { id: 'contenu_illicite', label: 'Contenu illicite' },
  { id: 'desinformation', label: 'Désinformation' },
  { id: 'contenu_choquant', label: 'Contenu choquant / NSFW' },
  { id: 'usurpation_identite', label: "Usurpation d'identité" },
  { id: 'autre_violation', label: 'Autre violation' },
];

module.exports = { THEMES, VIOLATION_RULES };
