/**
 * Validation d'un emoji de réaction.
 *
 * Les réactions étaient limitées à six emojis codés en dur, ce qui empêchait
 * tout sélecteur libre côté app (façon Instagram) : un emoji hors liste était
 * refusé en 400. On valide désormais la FORME plutôt qu'une liste fermée.
 *
 * Trois conditions, et pas une de moins :
 *  - une seule grappe de graphèmes, pour qu'un « message » entier ne puisse pas
 *    passer pour une réaction (`Intl.Segmenter`, sinon on ne saurait pas où
 *    s'arrête un emoji composé — « 👨‍👩‍👧‍👦 » fait 11 unités de code mais un
 *    seul graphème) ;
 *  - au moins un caractère réellement pictographique, ce qui écarte le texte
 *    ordinaire (« a » est bien un graphème unique) ;
 *  - une longueur bornée, parce que la colonne en base l'est aussi.
 */

/** Doit rester >= à la taille de la colonne `message_reactions.emoji`. */
const MAX_EMOJI_LENGTH = 32;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Les emojis « clavier » (1️⃣, #️⃣) ne sont pas pictographiques : c'est le
// combinateur U+20E3 qui les fait emojis.
const KEYCAP = /⃣/u;
// Les drapeaux non plus : ce sont deux indicateurs régionaux accolés (🇫🇷 =
// « F » + « R »), et aucun des deux n'est pictographique.
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('fr', { granularity: 'grapheme' })
  : null;

function isSingleEmoji(value) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str || str.length > MAX_EMOJI_LENGTH) return false;
  // Un indicateur régional seul n'est pas un drapeau — il s'affiche comme une
  // lettre encadrée. Un drapeau, c'est exactement deux.
  const regionalCount = (str.match(/\p{Regional_Indicator}/gu) || []).length;
  if (regionalCount > 0 && regionalCount !== 2) return false;

  if (!PICTOGRAPHIC.test(str) && !KEYCAP.test(str) && regionalCount === 0) return false;

  // Sans `Intl.Segmenter`, on refuse plutôt que de laisser passer : mieux vaut
  // une réaction rejetée qu'un texte arbitraire stocké comme emoji.
  if (!segmenter) return false;
  return [...segmenter.segment(str)].length === 1;
}

module.exports = { isSingleEmoji, MAX_EMOJI_LENGTH };
