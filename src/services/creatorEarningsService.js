const { sequelize } = require('../database/index');
const { roundTWC } = require('../economy');
const { DEFAULT_TIME_ZONE, isValidTimeZone, zonedDayKey } = require('../utils/timezone');

/**
 * Ce que le compte a encaissé, jour par jour.
 *
 * Le studio affichait un total et rien d'autre. Un total sans passé ne dit ni
 * si ça monte, ni si l'abonnement sert à quelque chose — au démarrage, c'est
 * précisément le moment où il faut le montrer. D'où la série quotidienne,
 * l'écart avec la période précédente et la répartition par source.
 *
 * Deux sources aujourd'hui, toutes deux NETTES de commission (c'est ce qui
 * arrive vraiment sur le portefeuille, pas le prix affiché) :
 * les ventes de contenu payant et les ventes de pseudo.
 *
 * Les jours sont ceux du CRÉATEUR, pas ceux du serveur : une vente à 1 h du
 * matin à Paris appartient à la veille en UTC, et la courbe se décalerait.
 */

/** Bornes larges : sous 7 jours la courbe ne dit rien, au-delà de 90 elle pèse. */
function normalizeWindow(days) {
  const parsed = parseInt(days, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(parsed, 7), 90);
}

async function earningsFor(userId, { days = 30, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const window = normalizeWindow(days);
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;

  // On récupère DEUX fenêtres d'un coup : la courante pour la courbe, la
  // précédente pour l'écart. Un second appel ferait deux fois le travail.
  const since = new Date(Date.now() - window * 2 * 86400000);

  const rows = await sequelize.query(`
    SELECT
      (cp.created_at AT TIME ZONE :timeZone)::date AS day,
      'content' AS source,
      SUM(cp.creator_net_twc)::numeric AS net
    FROM content_purchases cp
    WHERE cp.creator_id = :userId
      AND cp.refunded_at IS NULL
      AND cp.created_at >= :since
    GROUP BY 1

    UNION ALL

    SELECT
      (us.created_at AT TIME ZONE :timeZone)::date AS day,
      'username' AS source,
      SUM(us.seller_net_twc)::numeric AS net
    FROM username_sales us
    WHERE us.seller_id = :userId
      AND us.created_at >= :since
    GROUP BY 1
  `, {
    replacements: { userId: String(userId), since, timeZone: zone },
    type: sequelize.QueryTypes.SELECT,
  });

  const byDay = new Map();
  const bySource = { content: 0, username: 0 };
  for (const row of rows) {
    const day = String(row.day).slice(0, 10);
    const net = Number(row.net) || 0;
    byDay.set(day, roundTWC((byDay.get(day) || 0) + net));
    if (row.source === 'content' || row.source === 'username') {
      bySource[row.source] = roundTWC(bySource[row.source] + net);
    }
  }

  // Série complète, trous compris : une courbe qui saute les jours sans vente
  // ment sur le rythme.
  const series = [];
  let net = 0;
  let previousNet = 0;
  for (let offset = window * 2 - 1; offset >= 0; offset -= 1) {
    const day = zonedDayKey(new Date(Date.now() - offset * 86400000), zone);
    const value = byDay.get(day) || 0;
    if (offset < window) {
      series.push({ day, net: value });
      net = roundTWC(net + value);
    } else {
      previousNet = roundTWC(previousNet + value);
    }
  }

  // Pas de pourcentage quand on part de zéro : « +∞ % » ne veut rien dire, et
  // « +100 % » sur une première vente serait faux.
  const deltaPercent = previousNet > 0
    ? Math.round(((net - previousNet) / previousNet) * 100)
    : null;

  // La répartition porte sur les DEUX fenêtres réunies ; sur la seule fenêtre
  // courante elle serait vide la plupart du temps au démarrage.
  return {
    window_days: window,
    net,
    previous_net: previousNet,
    delta_percent: deltaPercent,
    by_source: bySource,
    series,
  };
}

module.exports = { earningsFor, normalizeWindow };
