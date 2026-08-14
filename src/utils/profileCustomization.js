'use strict';

/**
 * Personnalisation de profil premium (façon Discord).
 *
 * Ces règles vivaient dans `routes/userRoutes.js`, où seule la route
 * d'enregistrement les voyait. L'expiration d'un abonnement en a besoin elle
 * aussi : la personnalisation est stockée sur l'utilisateur et servie telle
 * quelle par tous les flux (fil, messages, notifications, recherche), donc
 * sans neutralisation à l'échéance, un abonné expiré gardait sa bannière, son
 * décor d'avatar et son nom animé indéfiniment, aux yeux de tout le monde.
 */

const { TIER } = require('../constants/subscriptionTiers');

/** Palettes proposées : on ne stocke que des couleurs validées, jamais du CSS libre. */
const PROFILE_BANNER_STYLES = ['none', 'gradient', 'glow', 'mesh', 'stripes'];
const PROFILE_AVATAR_DECORATIONS = ['none', 'ring', 'crown', 'petals', 'circuit', 'flames', 'stars'];
/** Force du thème de profil : le même dégradé, plus ou moins poussé. */
const PROFILE_THEME_INTENSITIES = ['soft', 'normal', 'vivid'];
/**
 * Nom affiché : police + traitement animé (palier Pro).
 * Le vocabulaire des polices est celui que le client mobile sait déjà résoudre
 * (`utils/profileDisplayNamePrefs`) — il était jusqu'ici stocké sur l'appareil,
 * donc invisible pour les visiteurs.
 */
// Liste fermée : une valeur absente d'ici est silencieusement ignorée à
// l'enregistrement (voir plus bas), sans erreur renvoyée au client. Elle doit
// donc rester alignée mot pour mot sur `NameFont` côté app
// (services/profileCustomizationService) et sur `DisplayNameFontId`
// (utils/profileDisplayNamePrefs).
const PROFILE_NAME_FONTS = [
  'system', 'display', 'editorial', 'serif', 'mono', 'compact',
  // Dix familles ajoutées, embarquées en Bold réel côté app.
  'geometric', 'rounded', 'elegant', 'soft', 'friendly',
  'classic', 'grotesque', 'techno', 'handwritten', 'roman',
];
const PROFILE_NAME_EFFECTS = ['none', 'gradient', 'shimmer', 'glow', 'certified'];
/** Taille du pseudo affiché sur le profil (palier Pro, comme police/effet). */
const PROFILE_NAME_SIZES = ['normal', 'large', 'xlarge', 'huge', 'giant'];

/**
 * « Certifié » ne se paie pas : il reprend la couleur du badge de vérification
 * et ne s'ouvre qu'aux comptes `verified`. C'est le seul habillage adossé à la
 * certification plutôt qu'au palier d'abonnement — un compte Pro non certifié
 * n'y a pas droit, un compte certifié gratuit y a droit.
 */
const CERTIFIED_NAME_EFFECT = 'certified';
/** Ambiance animée peinte EN FOND du profil, jamais par-dessus (palier Pro). */
const PROFILE_EFFECTS = ['none', 'sparkles', 'embers', 'bubbles', 'snow'];
/** Titre libre affiché sous le pseudo — court, sinon il concurrence la bio. */
const PROFILE_TITLE_MAX = 40;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Habillages POSSÉDÉS, gagnés en récompense d'événement.
 *
 * ── Pourquoi ils ne peuvent pas venir de la requête ───────────────────────
 * `owned` est lu sur l'enregistrement EXISTANT, jamais sur le corps envoyé par
 * le client. C'est ce qui empêche n'importe qui de s'accorder tous les
 * cosmétiques en postant `unlocked: [...]` — le seul écrivain légitime est
 * `eventQuestService.grantCosmetic`, après une quête réellement terminée.
 *
 * ── Et pourquoi il faut le réinjecter ─────────────────────────────────────
 * Le sanitizer construit un objet NEUF : tout champ non recopié disparaît. Sans
 * ce report, la première sauvegarde de profil effacerait les récompenses
 * d'événement — quelqu'un qui change sa couleur d'accent perdrait la police
 * qu'il a gagnée.
 */
function ownedTokens(existing) {
  const list = existing && Array.isArray(existing.unlocked) ? existing.unlocked : [];
  return list.filter((token) => typeof token === 'string');
}

/**
 * @param existing enregistrement actuel, source des habillages possédés. Sans
 *   lui, la fonction se comporte comme avant : seul le palier ouvre les droits.
 */
function sanitizeCustomization(input, tier, { verified = false, existing = null } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const output = {};
  // Un compte certifié gratuit passe la porte de la route pour son seul effet
  // de nom : tout le reste reste payant, d'où ce garde-fou champ par champ.
  const paid = tier !== TIER.FREE;

  const owned = ownedTokens(existing);
  /**
   * Palier OU possession.
   *
   * Un habillage gagné à un événement est acquis À VIE : le refuser parce que
   * l'abonnement a expiré reviendrait à reprendre une récompense, ce qui vide
   * de sens la promesse « on ne la reverra pas ».
   */
  const allows = (slot, value) => tier === TIER.PRO || owned.includes(`${slot}:${value}`);

  if (paid && typeof source.accent_color === 'string' && HEX_COLOR.test(source.accent_color.trim())) {
    output.accent_color = source.accent_color.trim().toLowerCase();
  }
  if (paid && typeof source.secondary_color === 'string' && HEX_COLOR.test(source.secondary_color.trim())) {
    output.secondary_color = source.secondary_color.trim().toLowerCase();
  }
  if (paid && PROFILE_BANNER_STYLES.includes(source.banner_style)) {
    output.banner_style = source.banner_style;
  }
  if (paid && PROFILE_THEME_INTENSITIES.includes(source.theme_intensity)) {
    output.theme_intensity = source.theme_intensity;
  }
  // Les décorations d'avatar sont l'avantage exclusif du palier Pro.
  if (PROFILE_AVATAR_DECORATIONS.includes(source.avatar_decoration)) {
    output.avatar_decoration = allows('avatar_decoration', source.avatar_decoration)
      ? source.avatar_decoration
      : 'none';
  }
  // Même règle pour les deux habillages animés arrivés ensuite : ils sont la
  // contrepartie visible du palier Pro, un compte Plus les voit mais ne les
  // enregistre pas.
  if (PROFILE_NAME_FONTS.includes(source.name_font)) {
    output.name_font = allows('name_font', source.name_font) ? source.name_font : 'system';
  }
  if (PROFILE_NAME_EFFECTS.includes(source.name_effect)) {
    // Deux droits différents selon l'effet : « Certifié » suit le badge, les
    // autres suivent le palier payant.
    const allowed = source.name_effect === CERTIFIED_NAME_EFFECT
      ? verified
      : tier === TIER.PRO;
    output.name_effect = allowed ? source.name_effect : 'none';
  }
  if (PROFILE_EFFECTS.includes(source.profile_effect)) {
    output.profile_effect = allows('profile_effect', source.profile_effect)
      ? source.profile_effect
      : 'none';
  }
  if (PROFILE_NAME_SIZES.includes(source.name_size)) {
    output.name_size = tier === TIER.PRO ? source.name_size : 'normal';
  }
  if (paid && typeof source.profile_title === 'string') {
    const title = source.profile_title.trim().replace(/\s+/g, ' ').slice(0, PROFILE_TITLE_MAX);
    if (title) output.profile_title = title;
  }
  if (paid && typeof source.about_me === 'string') {
    const about = source.about_me.trim().slice(0, 300);
    if (about) output.about_me = about;
  }
  // Report des possessions, en DERNIER et depuis l'enregistrement existant :
  // le sanitizer construit un objet neuf, donc sans cette ligne la premiere
  // sauvegarde de profil effacerait les recompenses d'evenement.
  if (owned.length > 0) output.unlocked = owned;

  return output;
}

/** Palier minimum pour personnaliser : Plus. Pro débloque les décorations. */
function customizationTier(user) {
  const tier = String(user?.subscription_tier || TIER.FREE);
  if (tier === TIER.PRO || tier === TIER.PLUS) return tier;
  // `premium` est l'ancien drapeau : il vaut Pro pour les comptes historiques.
  return user?.premium ? TIER.PRO : TIER.FREE;
}

/**
 * Ce qu'il reste d'une personnalisation quand le compte repasse en gratuit.
 *
 * Tout ce qui se paie disparaît ; seul l'effet de nom « Certifié » survit, et
 * uniquement pour un compte certifié, parce qu'il n'a jamais été adossé à
 * l'abonnement. Les valeurs par défaut ('none', 'system'…) ne sont pas
 * réécrites : les clients les traitent déjà comme une absence.
 *
 * ⚠ La version SQL de cette règle vit dans `expireDueSubscriptions`
 * (`utils/subscriptionHelpers.js`), qui neutralise en masse. Les deux doivent
 * rester d'accord.
 */
function freeTierCustomization(current, { verified = false } = {}) {
  if (current && typeof current === 'object'
    && verified && current.name_effect === CERTIFIED_NAME_EFFECT) {
    return { name_effect: CERTIFIED_NAME_EFFECT };
  }
  return {};
}

/** true si la personnalisation contient au moins un réglage payant actif. */
function hasPaidCustomization(current, { verified = false } = {}) {
  if (!current || typeof current !== 'object') return false;
  const kept = freeTierCustomization(current, { verified });
  const meaningful = Object.entries(current).filter(([key, value]) => {
    if (value === undefined || value === null || value === '') return false;
    // Les valeurs par défaut ne sont pas des avantages.
    if (key === 'avatar_decoration' || key === 'name_effect' || key === 'profile_effect') {
      return value !== 'none';
    }
    if (key === 'name_font') return value !== 'system';
    if (key === 'name_size') return value !== 'normal';
    return true;
  });
  return meaningful.some(([key, value]) => kept[key] !== value);
}

/**
 * Habillage à mettre de côté quand le compte repasse en gratuit.
 *
 * On archive la personnalisation complète telle qu'elle était, sans la trier :
 * c'est au réabonnement qu'on la repasse au filtre du palier retrouvé. Un
 * ancien Pro qui revient en Plus récupère ainsi ce que Plus autorise, et pas
 * plus.
 *
 * @returns {object|null} null s'il n'y a rien qui vaille la peine d'être gardé
 */
function archiveForDowngrade(current, { verified = false } = {}) {
  if (!hasPaidCustomization(current, { verified })) return null;
  return { ...current };
}

/**
 * Habillage rendu au réabonnement, repassé au filtre du palier acheté.
 *
 * @returns {object|null} null si rien n'était en attente
 */
function restoreFromArchive(archive, tier, { verified = false } = {}) {
  if (!archive || typeof archive !== 'object') return null;
  const restored = sanitizeCustomization(archive, tier, { verified });
  return Object.keys(restored).length ? restored : null;
}

module.exports = {
  PROFILE_BANNER_STYLES,
  PROFILE_AVATAR_DECORATIONS,
  PROFILE_THEME_INTENSITIES,
  PROFILE_NAME_FONTS,
  PROFILE_NAME_EFFECTS,
  PROFILE_NAME_SIZES,
  PROFILE_EFFECTS,
  PROFILE_TITLE_MAX,
  CERTIFIED_NAME_EFFECT,
  sanitizeCustomization,
  customizationTier,
  freeTierCustomization,
  hasPaidCustomization,
  archiveForDowngrade,
  restoreFromArchive,
};
