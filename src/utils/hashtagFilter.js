const { literal } = require('sequelize');

/**
 * AUDIT R2-09 (2026-08-19), CRITIQUE — confirmé en production (`psql`) :
 * `hashtags` est bien `jsonb`, et `Op.overlap` génère l'opérateur `&&`, qui
 * n'existe pas entre `jsonb` et un tableau texte littéral. Chaque appel à
 * `{ hashtags: { [Op.overlap]: [...] } }` levait donc une erreur SQL
 * (`operator does not exist: jsonb && text[]`) — la recherche par hashtag
 * était cassée en production sur les 9 sites qui l'utilisaient.
 *
 * `?|` (« l'un de ces éléments existe-t-il dans le tableau JSON ? ») porte
 * la même sémantique « n'importe lequel » que l'`&&` visé à l'origine, et
 * reste servi par l'index GIN existant (`jsonb_ops` couvre `@>`, `?`, `?|`,
 * `?&`). Paramétrée par échappement Sequelize, jamais par interpolation
 * directe de chaîne.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string} column - nom (non qualifié) de la colonne JSONB
 * @param {string[]} values
 */
function jsonbArrayOverlap(sequelize, column, values) {
  const list = (values || []).filter((v) => v !== null && v !== undefined && v !== '');
  if (list.length === 0) {
    // Aucune valeur à chercher : ne doit jamais matcher, plutôt que de
    // produire un `?|` vide (invalide) ou de tout renvoyer par erreur.
    return literal('false');
  }
  const escaped = list.map((v) => sequelize.escape(String(v))).join(', ');
  return literal(`${column} ?| ARRAY[${escaped}]`);
}

module.exports = { jsonbArrayOverlap };
