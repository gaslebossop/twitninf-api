/**
 * Miroir du temps de lecture vers `user_behavior_data`.
 *
 * LE PROBLÈME QU'IL RÉSOUT
 *
 * L'app mesure bien le temps passé sur un tweet en lecture plein écran
 * (`ExploreImmersive` → `handleExploreDwell` → `neuralRankService`), et
 * l'envoie. Mais elle l'envoie au SEUL moteur de recommandation Rust :
 * `neuralRankRoutes /track` et `trackingRoutes /` relaient `dwellMs` à
 * `rustClient` et n'écrivent rien en base.
 *
 * Or le pot créateur (`economy/creatorPool/signals.js`) cherche le temps de
 * lecture ailleurs — dans `user_behavior_data`, sur les lignes
 * `action_type = 'time_spent'` portant `context_data.time_spent_ms`, jointes
 * aux tweets par `target_id`. Le seul producteur de `time_spent` était
 * `useBehaviorTracking` côté app, qui l'enregistre pour un ÉCRAN
 * (`target_type = 'screen'`, `target_id = 'TweetsScreen'`) : ces lignes ne
 * joignent jamais la table `tweets`.
 *
 * Résultat avant ce module : `dwellRows = 0` pour TOUS les créateurs, donc
 * `hasRealDwell = false`, donc `attentionFactor = attentionProxyDiscount`
 * (0,5 par défaut). Le signal Attention — le plus lourd du score — tournait en
 * permanence sur une estimation décotée de moitié, pour tout le monde, alors
 * que la mesure réelle existait à deux tables de là.
 *
 * POURQUOI ICI ET PAS DANS L'APP NI DANS LE RUST
 *
 * Les deux routes ci-dessus sont le point de passage obligé de tout dwell qui
 * remonte du téléphone. Miroiter ici couvre d'un coup toutes les surfaces,
 * présentes et à venir, sans rien dupliquer côté client et sans demander au
 * moteur Rust d'écrire dans une base qui n'est pas la sienne.
 *
 * L'écriture est délibérément « au mieux » : une erreur ici ne doit jamais
 * faire échouer le tracking de recommandation, qui reste le rôle principal de
 * ces routes.
 */

const behaviorCollector = require('./behaviorDataCollector');
const logger = require('../utils/logger');

/**
 * Même plafond que celui appliqué à la lecture par le pot
 * (`signals.js`, `dwellCap`). Le poser aussi à l'écriture évite qu'un
 * téléphone resté allumé toute la nuit inscrive une ligne aberrante qui
 * fausserait les moyennes d'autres calculs.
 */
const DWELL_CAP_MS = 600_000;

/** En dessous, c'est un passage, pas une lecture — et ça ne pèse rien. */
const DWELL_FLOOR_MS = 1000;

/** Les interactions qui portent un temps de lecture interprétable. */
const DWELL_ACTIONS = new Set(['view', 'read', 'impression']);

/**
 * Écrit le temps de lecture d'un tweet dans `user_behavior_data`.
 *
 * @param {object} params
 * @param {string} params.userId    Le lecteur (jamais l'auteur : le pot écarte
 *                                  lui-même `viewer = créateur`).
 * @param {string} params.tweetId   Cible de la lecture.
 * @param {string} params.action    Type d'interaction reçu par la route.
 * @param {number} params.dwellMs   Durée mesurée côté client.
 * @param {object} [params.context] Nature du contenu, si la route la connaît.
 * @param {string} [params.ip]
 * @returns {Promise<boolean>} `true` si une ligne a été écrite.
 */
async function mirrorDwell({ userId, tweetId, action, dwellMs, context = null, ip = null }) {
  const ms = Number(dwellMs);

  // Trace de mise en service : dit ce que la route a REELLEMENT recu, avant
  // toute garde. Sans elle, un rejet (mauvais type d'action, duree sous le
  // seuil, champ absent) est indiscernable d'un appel qui n'est jamais parti.
  logger.info(`⏱️ dwell recu: action=${action} ms=${dwellMs} tweet=${tweetId || 'AUCUN'}`);

  if (!userId || !tweetId) return false;
  if (!DWELL_ACTIONS.has(String(action))) return false;
  if (!Number.isFinite(ms) || ms < DWELL_FLOOR_MS) return false;

  const capped = Math.min(Math.round(ms), DWELL_CAP_MS);

  try {
    await behaviorCollector.recordUserAction(
      userId,
      'time_spent',
      String(tweetId),
      // `'tweet'` impérativement : c'est sur cette valeur que le pot filtre
      // avant de joindre la table des tweets.
      'tweet',
      {
        time_spent_ms: capped,
        // Trace l'origine de la ligne : elle vient d'une mesure de lecture
        // relayée, pas d'un `endContentEngagement` d'écran.
        source: 'dwell',
        ...(context || {}),
      },
      {},
      ip
    );
    // Trace explicite : `recordUserAction` logge deja « time_spent », mais sans
    // dire s'il s'agit d'un ECRAN ou d'un TWEET — or c'est toute la difference,
    // seul le second alimente le pot. Une ligne par lecture reelle rend la mise
    // en service verifiable d'un `pm2 logs | grep dwell`.
    logger.info(`⏱️ dwell ${capped}ms sur le tweet ${tweetId} (lecteur ${userId})`);
    return true;
  } catch (error) {
    // Au mieux : le tracking de recommandation ne doit pas tomber avec.
    logger.warn(`⚠️ Miroir du temps de lecture impossible (tweet ${tweetId}): ${error.message}`);
    return false;
  }
}

module.exports = { mirrorDwell, DWELL_CAP_MS, DWELL_FLOOR_MS, DWELL_ACTIONS };
