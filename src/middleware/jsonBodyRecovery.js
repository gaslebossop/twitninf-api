const logger = require('../utils/logger');

/**
 * Rattrape les corps JSON DOUBLEMENT encodes envoyes par les applications
 * deja installees.
 *
 * ── Le defaut d'origine ────────────────────────────────────────────────────
 * Une version du client appelait `JSON.stringify()` sur un corps que sa couche
 * reseau stringifiait ensuite une seconde fois. Le serveur recevait donc une
 * CHAINE JSON la ou il attendait un objet. Corrige cote application depuis,
 * mais **une application deja installee ne se corrige pas a distance** : les
 * envois des versions plus anciennes continuent d'arriver, et sans rattrapage
 * ils sont perdus. Sur la seule journee du 2026-08-18, 128 rejets sur
 * `/api/neural-rank/track` — chaque like, temps de lecture ou « pas
 * interesse » disparaissait avant d'atteindre le moteur de recommandation.
 *
 * ── Pourquoi DEUX middlewares ──────────────────────────────────────────────
 * Selon le nombre de couches d'encodage, `express.json` reussit ou echoue :
 *
 *  - `express.json` tourne en mode `strict` par defaut : il n'accepte au
 *    premier niveau QU'UN OBJET OU UN TABLEAU. Une chaine JSON — c'est
 *    exactement ce que produit un double encodage — est donc REFUSEE avant
 *    tout middleware normal, avec `entity.parse.failed`. En pratique c'est
 *    `recoverUnparsableBody` qui fait le travail, et le corps brut n'est plus
 *    accessible que dans `err.body`.
 *  - `unwrapStringBody` reste utile pour les montages ou `strict` serait
 *    desactive, ou si un parseur amont laisse passer une chaine.
 *
 * Verifie par les tests : c'est le second qui traite le cas reel.
 */

/**
 * Deballe des couches successives de `JSON.stringify` jusqu'a obtenir un
 * OBJET, ou rend `null`.
 *
 * Le nombre de couches n'est pas connu d'avance (il depend de la version du
 * client), d'ou la boucle plutot qu'un nombre fixe. La borne evite qu'une
 * entree construite exprès ne fasse tourner le parseur indefiniment.
 *
 * Rend `null` — et non la valeur intermediaire — quand on n'atteint jamais un
 * objet : une chaine reste alors une chaine, et l'appelant decide.
 */
const MAX_UNWRAP_DEPTH = 4;

function unwrapToObject(raw) {
  let candidate = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
    if (candidate && typeof candidate === 'object') return candidate;
    if (typeof candidate !== 'string') return null;
  }
  return null;
}

/**
 * Deballe un corps que `express.json` a rendu sous forme de chaine.
 *
 * Volontairement etroit : une seule couche, et uniquement si elle rend un
 * OBJET. Un corps qui est legitimement une chaine JSON (`"bonjour"`) doit le
 * rester — sinon on casserait des routes qui en attendent une.
 */
function unwrapStringBody(req, _res, next) {
  if (typeof req.body === 'string' && req.body.length > 1) {
    const unwrapped = unwrapToObject(req.body);
    if (unwrapped) {
      req.body = unwrapped;
      logger.debug(`Corps JSON doublement encode rattrape sur ${req.method} ${req.path}`);
    }
  }
  next();
}

/**
 * Rattrape un corps que `express.json` a refuse de parser.
 *
 * Rend 400 et non 500 quand la recuperation echoue : un corps mal forme est
 * une faute du client, et repondre 500 accusait le serveur a tort — ce qui
 * fausse aussi toute lecture des journaux.
 */
function recoverUnparsableBody(err, req, res, next) {
  if (err?.type !== 'entity.parse.failed') return next(err);

  const raw = typeof err.body === 'string' ? err.body : null;
  if (raw) {
    const recovered = unwrapToObject(raw);
    if (recovered) {
      req.body = recovered;
      logger.debug(`Corps JSON illisible rattrape sur ${req.method} ${req.path}`);
      return next();
    }
  }

  logger.warn(`Corps JSON irrecuperable sur ${req.method} ${req.path}`);
  return res.status(400).json({ success: false, message: 'Corps de requete illisible' });
}

module.exports = { unwrapStringBody, recoverUnparsableBody };
