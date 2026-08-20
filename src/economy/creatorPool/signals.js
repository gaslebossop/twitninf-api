/**
 * Signaux de qualité d'une période, agrégés par créateur.
 *
 * Trois principes repris de `scout/` (le prototype Go qui a servi à valider
 * ces mesures sur des données réelles) :
 *
 * 1. **Tout est mesuré en TAUX, jamais en volume brut.** Le volume revient
 *    ensuite une seule fois, dans `vues_qualifiées` (voir `index.js`). Sans
 *    ça, la qualité et la taille de l'audience seraient comptées deux fois et
 *    seuls les gros comptes toucheraient quoi que ce soit.
 *
 * 2. **Chaque interaction est pondérée par la confiance accordée à son
 *    auteur.** Un compte issu d'une rafale de création scriptée pèse 0 — voir
 *    `TRUST_*` plus bas. C'est ce qui rend l'auto-farming non rentable : se
 *    fabriquer mille spectateurs ne fabrique aucune vue qualifiée.
 *
 * 3. **Les événements sont lus depuis `user_behavior_data`, qui est horodaté,
 *    et jamais depuis `tweets.view_count`, qui est un cumul.** C'est ce qui
 *    permet à un tweet publié il y a un mois de rapporter encore cette
 *    semaine : la période ne regarde pas la date du tweet, elle regarde la
 *    date des événements qu'il a produits.
 *
 * Aucune écriture : ce module lit, il ne décide de rien.
 */

const { sequelize } = require('../../database/index');
const logger = require('../../utils/logger');

/** Fenêtre de création qui définit une rafale scriptée (cf. `scout/trust.go`). */
const BURST_WINDOW_SECONDS = 5;
/** Nombre de comptes créés dans cette fenêtre au-delà duquel on parle de rafale. */
const BURST_MIN_CLUSTER = 10;
/** Profondeur d'historique servant à juger la diversité d'activité d'un compte. */
const TRUST_LOOKBACK_DAYS = 90;

/** Sources d'impression à ne jamais payer : l'annonceur les a déjà payées au CPM. */
const AD_SOURCES = ['ad', 'ads', 'sponsored', 'promoted', 'advertisement'];

/**
 * ── Pourquoi le taux d'attention a son propre dénominateur ──────────────────
 *
 * `attentionRate` divise le temps de lecture mesuré par un nombre de vues.
 * Toute vue mise à ce dénominateur SANS avoir pu produire de temps de lecture
 * écrase la moyenne d'autant. Or l'émission de `time_spent` dépend du CLIENT
 * qui regarde : le fil ne l'a instrumenté que très récemment, le lecteur
 * plein écran d'Explorer bien avant, et une version d'app plus ancienne
 * n'émet toujours rien du tout.
 *
 * Relevé en prod le 2026-08-20, sur les tweets d'un même créateur : 1,29 s/vue
 * en divisant par toutes les vues de la semaine, contre 6,15 s/vue en ne
 * divisant que par les vues réellement mesurables — un facteur 4,8 de
 * sous-estimation, subi par tout le monde.
 *
 * Une simple date de bascule ne suffit pas : il n'y en a jamais eu. Les
 * relevés quotidiens montrent des semaines de couverture partielle (quelques
 * dizaines d'événements pour des centaines de vues) avant la généralisation.
 * Le critère retenu est donc par COUPLE (spectateur, jour) : si un
 * spectateur a émis au moins un temps de lecture ce jour-là, son client
 * instrumente, et toutes ses vues du jour comptent au dénominateur ; sinon
 * son client n'instrumente pas, et aucune n'y entre.
 *
 * Deux propriétés voulues :
 *   * un survol RÉEL continue de compter — le spectateur instrumenté qui
 *     passe vite fait bien baisser la moyenne, c'est le signal recherché ;
 *   * la correction s'efface d'elle-même : quand tout le parc instrumente,
 *     `measurableViews == qualifiedViews` et le calcul redevient l'ancien.
 *
 * ⚠ Ne corrige QUE ce dénominateur. Le volume (`qualifiedViews`, seul facteur
 * de volume du poids) continue de compter TOUTES les vues : un créateur ne
 * doit pas être payé moins parce qu'une partie de son public utilise une
 * vieille version de l'app.
 */

/** Sous-requête : les couples (spectateur, jour) dont le client mesure le temps de lecture. */
const INSTRUMENTED_VIEWER_DAYS = `
  SELECT ubd.user_id AS viewer_id,
         (ubd.timestamp AT TIME ZONE 'UTC')::date AS day
  FROM user_behavior_data ubd
  WHERE ubd.action_type = 'time_spent'
    AND ubd.target_type = 'tweet'
    AND ubd.timestamp >= :start AND ubd.timestamp < :end
    AND ubd.is_data_test IS NOT TRUE
    AND ubd.user_id IS NOT NULL
  GROUP BY 1, 2
`;

/**
 * Confiance accordée aux interactions d'un compte, dans `[0, 1]`.
 *
 * Portage direct de `computeTrustWeights` (`scout/trust.go`). Un compte sans
 * la moindre donnée comportementale reçoit 0,3 et non 0 : l'absence de
 * données prouve surtout que son client n'instrumente rien (le web n'émet
 * quasiment rien), pas qu'il s'agit d'un robot.
 */
function trustWeight({ clusterSize, actionTypes, activeDays, hasBehaviour }) {
  if (clusterSize >= BURST_MIN_CLUSTER) return 0;
  if (!hasBehaviour) return 0.3;
  const types = Math.min(actionTypes || 0, 5);
  const days = Math.min(activeDays || 0, 10);
  return Math.min(1, 0.3 + 0.1 * types + 0.05 * days);
}

/**
 * Table de confiance des comptes ayant produit un événement dans la fenêtre.
 *
 * Restreinte aux acteurs de la période : c'est le seul ensemble qui compte, et
 * il est de plusieurs ordres de grandeur plus petit que `users` (dont 97 %
 * vient de deux rafales scriptées).
 */
async function loadTrustWeights(start, end) {
  const rows = await sequelize.query(
    `
    WITH actors AS (
      SELECT DISTINCT ubd.user_id AS id
      FROM user_behavior_data ubd
      WHERE ubd.timestamp >= :start AND ubd.timestamp < :end
        AND ubd.is_data_test IS NOT TRUE
        AND ubd.user_id IS NOT NULL
    ),
    burst AS (
      -- Taille du voisinage de création. Un compte appartenant à une rafale a
      -- forcément BURST_MIN_CLUSTER voisins créés à quelques secondes de lui ;
      -- un compte créé par un humain en a un ou deux.
      SELECT a.id,
             (SELECT COUNT(*) FROM users v
               WHERE v.created_at >= u.created_at - (:burstWindow * INTERVAL '1 second')
                 AND v.created_at <= u.created_at + (:burstWindow * INTERVAL '1 second')
             ) AS cluster_size
      FROM actors a
      JOIN users u ON u.id = a.id
    ),
    diversity AS (
      SELECT ubd.user_id AS id,
             COUNT(DISTINCT ubd.action_type) AS action_types,
             COUNT(DISTINCT (ubd.timestamp AT TIME ZONE 'UTC')::date) AS active_days
      FROM user_behavior_data ubd
      WHERE ubd.timestamp >= :trustSince
        AND ubd.is_data_test IS NOT TRUE
        AND ubd.user_id IN (SELECT id FROM actors)
      GROUP BY ubd.user_id
    )
    SELECT b.id,
           b.cluster_size,
           d.action_types,
           d.active_days
    FROM burst b
    LEFT JOIN diversity d ON d.id = b.id
    `,
    {
      replacements: {
        start,
        end,
        burstWindow: BURST_WINDOW_SECONDS,
        trustSince: new Date(start.getTime() - TRUST_LOOKBACK_DAYS * 24 * 3600 * 1000),
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const map = new Map();
  for (const r of rows) {
    map.set(String(r.id), trustWeight({
      clusterSize: parseInt(r.cluster_size, 10) || 0,
      actionTypes: parseInt(r.action_types, 10) || 0,
      activeDays: parseInt(r.active_days, 10) || 0,
      hasBehaviour: r.action_types != null,
    }));
  }
  return map;
}

/**
 * Événements d'audience de la période, ligne par ligne mais déjà réduits :
 * une ligne par (créateur, spectateur, jour, nature). C'est le niveau de
 * détail minimal qui permet de calculer À LA FOIS les vues pondérées, les
 * spectateurs distincts, ceux qui reviennent un autre jour, et la DAU gagnée.
 *
 * Agréger plus finement côté SQL économiserait des lignes mais rendrait la
 * DAU incalculable : elle a besoin du couple (spectateur, jour).
 */
async function loadAudienceRows(start, end) {
  return sequelize.query(
    `
    WITH instrumented AS (${INSTRUMENTED_VIEWER_DAYS})
    SELECT t.user_id                                        AS creator_id,
           ubd.user_id                                      AS viewer_id,
           (ubd.timestamp AT TIME ZONE 'UTC')::date         AS day,
           SUM(CASE WHEN ubd.action_type = 'tweet_view'  THEN 1 ELSE 0 END) AS views,
           SUM(CASE WHEN ubd.action_type = 'tweet_click' THEN 1 ELSE 0 END) AS clicks,
           -- Ce spectateur mesurait-il le temps de lecture ce jour-là ? Le
           -- prédicat ne dépend que de (spectateur, jour), donc il est
           -- constant sur tout le groupe — voir le pavé en tête de fichier.
           BOOL_OR(ins.viewer_id IS NOT NULL)               AS viewer_instrumented,
           SUM(CASE WHEN ubd.action_type = 'time_spent'
                    THEN LEAST(COALESCE((ubd.context_data->>'time_spent_ms')::bigint, 0), :dwellCap)
                    ELSE 0 END)                             AS dwell_ms
    FROM user_behavior_data ubd
    JOIN tweets t ON t.id::text = ubd.target_id
    LEFT JOIN instrumented ins
           ON ins.viewer_id = ubd.user_id
          AND ins.day = (ubd.timestamp AT TIME ZONE 'UTC')::date
    WHERE ubd.timestamp >= :start AND ubd.timestamp < :end
      AND ubd.is_data_test IS NOT TRUE
      AND ubd.target_type = 'tweet'
      AND ubd.action_type IN ('tweet_view', 'tweet_click', 'time_spent')
      AND ubd.user_id IS NOT NULL
      AND ubd.user_id <> t.user_id
      AND COALESCE(ubd.context_data->>'source', '') <> ALL(CAST(:adSources AS text[]))
      AND t.deleted_at IS NULL
      AND t.is_data_test IS NOT TRUE
      AND t.parent_tweet_id IS NULL
      AND t.moderation_status = 'approved'
    GROUP BY t.user_id, ubd.user_id, (ubd.timestamp AT TIME ZONE 'UTC')::date
    `,
    {
      replacements: {
        start,
        end,
        dwellCap: 600000,
        adSources: `{${AD_SOURCES.join(',')}}`,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );
}

/**
 * Jours d'activité de chaque spectateur, sur la période ÉLARGIE d'un jour
 * avant le début.
 *
 * Ce jour supplémentaire n'est pas un détail : la DAU gagnée demande de
 * savoir si un spectateur était actif la VEILLE. Sans lui, tout le monde
 * paraîtrait réactivé le premier jour de la période, et le lundi vaudrait
 * mécaniquement plus que le mardi.
 */
async function loadActivityDays(start, end, viewerIds) {
  if (viewerIds.length === 0) return new Map();
  const rows = await sequelize.query(
    `
    SELECT ubd.user_id AS id,
           (ubd.timestamp AT TIME ZONE 'UTC')::date AS day
    FROM user_behavior_data ubd
    WHERE ubd.timestamp >= :from AND ubd.timestamp < :end
      AND ubd.is_data_test IS NOT TRUE
      AND ubd.user_id = ANY(CAST(:ids AS uuid[]))
    GROUP BY ubd.user_id, (ubd.timestamp AT TIME ZONE 'UTC')::date
    `,
    {
      replacements: {
        from: new Date(start.getTime() - 24 * 3600 * 1000),
        end,
        ids: `{${viewerIds.join(',')}}`,
      },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const map = new Map();
  for (const r of rows) {
    const key = String(r.id);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(String(r.day));
  }
  return map;
}

/** Abonnements gagnés pendant la période, par créateur, pondérés par la confiance. */
async function loadFollowsGained(start, end) {
  return sequelize.query(
    `
    SELECT uf.following_id AS creator_id,
           uf.follower_id  AS follower_id
    FROM user_follows uf
    WHERE uf.created_at >= :start AND uf.created_at < :end
      AND uf.status = 'active'
      AND uf.follower_id <> uf.following_id
    `,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );
}

/**
 * Signaux négatifs de la période, par créateur.
 *
 * Trois natures réunies parce qu'elles disent la même chose sous des formes
 * différentes — « ce contenu n'aurait pas dû m'être servi » :
 *   - `algo_check_answer` avec `liked = false` : la réponse explicite à la
 *     question posée dans le fil, le signal le plus propre qui existe ;
 *   - `tweet_report` : un signalement déposé, retenu ou non ;
 *   - `content_quality_events` : suppression par un modérateur ou tweet
 *     rendu non éligible par l'algorithme (voir `contentQualityService`).
 */
async function loadNegativeSignals(start, end) {
  const [behaviour, quality] = await Promise.all([
    sequelize.query(
      `
      SELECT t.user_id AS creator_id, COUNT(*) AS count
      FROM user_behavior_data ubd
      JOIN tweets t ON t.id::text = ubd.target_id
      WHERE ubd.timestamp >= :start AND ubd.timestamp < :end
        AND ubd.is_data_test IS NOT TRUE
        AND ubd.target_type = 'tweet'
        AND t.deleted_at IS NULL
        AND t.parent_tweet_id IS NULL
        AND (
          ubd.action_type = 'tweet_report'
          OR (ubd.action_type = 'algo_check_answer' AND ubd.context_data->>'liked' = 'false')
        )
      GROUP BY t.user_id
      `,
      { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `
      SELECT user_id AS creator_id, COUNT(*) AS count
      FROM content_quality_events
      WHERE occurred_at >= :start AND occurred_at < :end
      GROUP BY user_id
      `,
      { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
    ).catch((e) => {
      // Table pas encore créée au tout premier démarrage : l'absence
      // d'historique qualité ne doit pas empêcher une clôture.
      logger.warn(`[creatorPool] content_quality_events illisible: ${e.message}`);
      return [];
    }),
  ]);

  const map = new Map();
  const add = (id, n) => map.set(String(id), (map.get(String(id)) || 0) + n);
  for (const r of behaviour) add(r.creator_id, parseInt(r.count, 10) || 0);
  for (const r of quality) add(r.creator_id, parseInt(r.count, 10) || 0);
  return map;
}

/**
 * Agrège tout en un objet par créateur.
 *
 * Retourne des GRANDEURS BRUTES et des TAUX, pas encore de score : le passage
 * en rang percentile a besoin de connaître le vivier complet, il se fait donc
 * une couche au-dessus (`index.js`).
 */
async function collectPeriodSignals({ start, end }) {
  const [trust, audience, follows, negatives] = await Promise.all([
    loadTrustWeights(start, end),
    loadAudienceRows(start, end),
    loadFollowsGained(start, end),
    loadNegativeSignals(start, end),
  ]);

  const viewerIds = [...new Set(audience.map((r) => String(r.viewer_id)))];
  const activityDays = await loadActivityDays(start, end, viewerIds);

  const byCreator = new Map();
  const ensure = (id) => {
    const key = String(id);
    if (!byCreator.has(key)) {
      byCreator.set(key, {
        creatorId: key,
        qualifiedViews: 0,
        /** Vues qualifiées de la fenêtre instrumentée — dénominateur du taux d'attention. */
        measurableViews: 0,
        rawViews: 0,
        dwellMs: 0,
        dwellRows: 0,
        viewers: new Set(),
        viewerDays: new Map(),
        dauGained: 0,
        followsGained: 0,
        negatives: 0,
      });
    }
    return byCreator.get(key);
  };

  const DAY_MS = 24 * 3600 * 1000;

  for (const row of audience) {
    const w = trust.get(String(row.viewer_id)) ?? 0.3;
    if (w <= 0) continue; // Rafale scriptée : l'événement n'existe pas pour la paie.

    const c = ensure(row.creator_id);
    const views = parseInt(row.views, 10) || 0;
    const clicks = parseInt(row.clicks, 10) || 0;
    const dwell = parseInt(row.dwell_ms, 10) || 0;

    // Un clic depuis Explorer vaut deux vues passives — même arbitrage que
    // `computeEffectiveViews`, qui reste la référence pour les vues brutes.
    const qualified = w * (views + 2 * clicks);
    c.qualifiedViews += qualified;
    // Le client de ce spectateur mesurait-il le temps ce jour-là ? Sinon ses
    // vues n'entrent pas au dénominateur du taux d'attention.
    if (row.viewer_instrumented) c.measurableViews += qualified;
    c.rawViews += views + clicks;
    c.dwellMs += w * dwell;
    if (dwell > 0) c.dwellRows += 1;

    const viewer = String(row.viewer_id);
    c.viewers.add(viewer);
    if (!c.viewerDays.has(viewer)) c.viewerDays.set(viewer, new Set());
    c.viewerDays.get(viewer).add(String(row.day));

    // DAU gagnée : ce spectateur était-il inactif la veille ? Si oui, sa
    // journée d'aujourd'hui commence par ce créateur — c'est lui qui l'a
    // ramené.
    const days = activityDays.get(viewer);
    if (days) {
      const dayStr = String(row.day);
      const previous = new Date(`${dayStr}T00:00:00.000Z`).getTime() - DAY_MS;
      const previousStr = new Date(previous).toISOString().slice(0, 10);
      if (!days.has(previousStr)) c.dauGained += w;
    }
  }

  for (const row of follows) {
    const w = trust.get(String(row.follower_id)) ?? 0.3;
    if (w <= 0) continue;
    ensure(row.creator_id).followsGained += w;
  }

  for (const [creatorId, count] of negatives) {
    ensure(creatorId).negatives += count;
  }

  // Passage en taux. Le dénominateur est toujours l'audience, jamais le
  // nombre de tweets : publier davantage ne doit pas améliorer un taux.
  const out = [];
  for (const c of byCreator.values()) {
    const distinctViewers = c.viewers.size;
    let returning = 0;
    for (const days of c.viewerDays.values()) if (days.size > 1) returning += 1;

    out.push({
      creatorId: c.creatorId,
      qualifiedViews: c.qualifiedViews,
      measurableViews: c.measurableViews,
      rawViews: c.rawViews,
      distinctViewers,
      dwellMs: c.dwellMs,
      hasRealDwell: c.dwellRows > 0,
      // Attention : millisecondes moyennes par vue qualifiée, rapportées aux
      // seules vues MESURABLES — pas à toutes les vues de la période. Voir le
      // pavé « pourquoi le taux d'attention a son propre dénominateur ».
      attentionRate: c.measurableViews > 0 ? c.dwellMs / c.measurableViews : 0,
      // Rétention : abonnements gagnés + spectateurs revenus un autre jour,
      // rapportés aux spectateurs distincts.
      retentionRate: distinctViewers > 0 ? (c.followsGained + returning) / distinctViewers : 0,
      // DAU gagnée, rapportée aux spectateurs distincts.
      dauRate: distinctViewers > 0 ? c.dauGained / distinctViewers : 0,
      penaltyRate: c.qualifiedViews > 0 ? c.negatives / c.qualifiedViews : 0,
      raw: {
        followsGained: c.followsGained,
        returningViewers: returning,
        dauGained: c.dauGained,
        negatives: c.negatives,
      },
    });
  }

  return out;
}

module.exports = {
  BURST_WINDOW_SECONDS,
  BURST_MIN_CLUSTER,
  TRUST_LOOKBACK_DAYS,
  AD_SOURCES,
  trustWeight,
  collectPeriodSignals,
};
