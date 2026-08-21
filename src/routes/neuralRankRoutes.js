/**
 * Routes NeuralRank — Proxy vers le microservice Rust de recommandation.
 *
 * Montage dans server.js : app.use('/api/neural-rank', require('./routes/neuralRankRoutes'))
 *
 * Endpoints :
 *   GET  /api/neural-rank/recommendations          → Feed personnalisé (tweets complets)
 *   POST /api/neural-rank/track                    → Tracker une interaction
 *   POST /api/neural-rank/calibration/round         → Tour de recalibration (Paramètres, manuel)
 *   POST /api/neural-rank/calibration/finish        → Applique une session de recalibration
 *   GET  /api/neural-rank/health                   → Santé du service Rust
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { spaceOutReplies } = require('../utils/feedShape');
const rustClient = require('../services/rustRecommenderClient');
const { mirrorDwell } = require('../services/dwellMirror');
const { coalesceAuthorId } = require('../services/interactionAuthor');
const featureFlagService = require('../services/featureFlagService');
const paidContentService = require('../services/paidContentService');
const adService = require('../services/adService');
const { withFeedCache } = require('../services/feedCache');
const { sequelize } = require('../database');
const { QueryTypes } = require('sequelize');
const redis = require('redis');
const { engagementTargetSql } = require('../utils/engagementTarget');
const { visibleAuthorSql } = require('../utils/privateAccountVisibility');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client Redis dédié à NeuralRank pour l'invalidation
let _redisClient;
async function getRedisClient() {
  if (_redisClient && _redisClient.isReady) return _redisClient;
  // Le mot de passe Redis était écrit en dur en repli. Il ne vient plus que de
  // l'environnement — comme partout ailleurs (`config/config.js`,
  // `fraudDetectionService`), qui n'ont jamais eu de repli.
  _redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
  _redisClient.on('error', (e) => logger.warn('[NeuralRank Redis]', e.message));
  await _redisClient.connect();
  return _redisClient;
}

/**
 * Récupère les tweets complets depuis la DB à partir d'une liste d'IDs,
 * en préservant l'ordre Rust et en incluant author + interactions utilisateur.
 */
async function fetchTweetsByIds(tweetIds, userId, experimentAssignments = []) {
  if (!tweetIds || tweetIds.length === 0) return [];
  const assignmentByTweet = new Map(
    (Array.isArray(experimentAssignments) ? experimentAssignments : [])
      .filter(assignment => assignment?.tweet_id && assignment?.variant_id)
      .map(assignment => [String(assignment.tweet_id), assignment]),
  );

  // Les ids viennent du service Rust, mais ils sont interpolés dans le SQL :
  // on n'accepte que des UUID stricts plutôt que de faire confiance à la
  // sortie d'un service tiers.
  const safeIds = tweetIds.filter(id => UUID_RE.test(String(id)));
  if (safeIds.length === 0) return [];
  const idsStr = safeIds.map(id => `'${id}'`).join(',');

  const rows = await sequelize.query(`
    SELECT
      t.id,
      t.content,
      t.created_at,
      t.is_retweet,
      t.is_quote,
      t.parent_tweet_id,
      t.media_urls,
      t.hashtags,
      t.mentions,
      t.tweet_type,
      t.original_tweet_id,
      t.translation_enabled,
      -- Tweet d'origine (les retweets purs ont volontairement content = '')
      ot.id          AS original_id,
      ot.content     AS original_content,
      ot.created_at  AS original_created_at,
      ot.is_retweet  AS original_is_retweet,
      ot.is_quote    AS original_is_quote,
      ot.parent_tweet_id AS original_parent_tweet_id,
      ot.media_urls  AS original_media_urls,
      ot.hashtags    AS original_hashtags,
      ot.mentions    AS original_mentions,
      ot.tweet_type  AS original_tweet_type,
      ot.original_tweet_id AS original_original_tweet_id,
      ot.translation_enabled AS original_translation_enabled,
      -- Tweet parent (pour les réponses recommandées : affichées avec leur contexte)
      pt.id          AS parent_id,
      pt.content     AS parent_content,
      pt.created_at  AS parent_created_at,
      pt.media_urls  AS parent_media_urls,
      -- Auteur
      u.id          AS author_id,
      u.username    AS author_username,
      u.full_name   AS author_full_name,
      u.avatar      AS author_avatar,
      u.verified    AS author_verified,
      u.verification_style AS author_verification_style,
      u.premium     AS author_premium,
      -- Personnalisation : c'est elle qui habille le nom et la pastille dans le
      -- fil. Sans elle ici, chaque carte devrait aller la chercher elle-même.
      u.subscription_tier AS author_subscription_tier,
      u.profile_customization AS author_profile_customization,
      -- Auteur du tweet d'origine
      ou.id          AS original_author_id,
      ou.username    AS original_author_username,
      ou.full_name   AS original_author_full_name,
      ou.avatar      AS original_author_avatar,
      ou.verified    AS original_author_verified,
      ou.verification_style AS original_author_verification_style,
      ou.premium     AS original_author_premium,
      ou.subscription_tier AS original_author_subscription_tier,
      ou.profile_customization AS original_author_profile_customization,
      -- Auteur du tweet parent
      pu.id          AS parent_author_id,
      pu.username    AS parent_author_username,
      pu.full_name   AS parent_author_full_name,
      pu.avatar      AS parent_author_avatar,
      pu.verified    AS parent_author_verified,
      pu.verification_style AS parent_author_verification_style,
      pu.premium     AS parent_author_premium,
      pu.subscription_tier AS parent_author_subscription_tier,
      pu.profile_customization AS parent_author_profile_customization,
      -- Stats agrégées — portées par la cible d'engagement (l'original pour un
      -- retweet pur), jamais par la ligne retweet qui n'a aucun like propre.
      COALESCE((SELECT COUNT(*) FROM tweet_likes    WHERE tweet_id = et.target_id), 0) AS likes_count,
      COALESCE((SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = et.target_id), 0) AS retweets_count,
      COALESCE((SELECT COUNT(*) FROM tweets         WHERE parent_tweet_id = et.target_id AND deleted_at IS NULL), 0) AS replies_count,
      COALESCE(stt.view_count, t.view_count, 0) AS views_count,
      -- Interactions de l'utilisateur courant — sur la même cible que les
      -- compteurs, sinon le coeur et le nombre affiché se contredisent.
      EXISTS(SELECT 1 FROM tweet_likes    WHERE tweet_id = et.target_id AND user_id = :userId::uuid) AS is_liked,
      EXISTS(SELECT 1 FROM tweet_retweets WHERE tweet_id = et.target_id AND user_id = :userId::uuid) AS is_retweeted
    FROM tweets t
    CROSS JOIN LATERAL (SELECT ${engagementTargetSql('t')} AS target_id) et
    LEFT JOIN tweets stt ON stt.id = et.target_id
    JOIN users u ON u.id = t.user_id
    LEFT JOIN tweets ot
      ON ot.id = t.original_tweet_id
      AND ot.deleted_at IS NULL
      AND ot.moderation_status = 'approved'
      AND ot.is_private = false
    LEFT JOIN users ou ON ou.id = ot.user_id AND ou.is_active = true
    LEFT JOIN tweets pt
      ON pt.id = t.parent_tweet_id
      AND pt.deleted_at IS NULL
      AND pt.moderation_status = 'approved'
      AND pt.is_private = false
    LEFT JOIN users pu ON pu.id = pt.user_id AND pu.is_active = true
    WHERE t.id IN (${idsStr})
      AND t.deleted_at IS NULL
      AND t.moderation_status = 'approved'
      AND t.is_private = false
      -- Comptes privés : le moteur Rust classe des tweets sans rien savoir de
      -- la confidentialité des comptes, c'est donc ici que ça se joue. Le
      -- filtre porte AUSSI sur l'auteur de l'original : sinon il suffisait
      -- qu'un compte public retweete un compte privé pour le rendre lisible de
      -- tous, ce qui vide le réglage de son sens.
      AND ${visibleAuthorSql('u')}
      -- Le cas "ou.id IS NULL" est conservé tel quel : la jointure est déjà
      -- LEFT et filtrée sur is_active, et le code aval sait afficher un retweet
      -- dont l'auteur d'origine a disparu. Sans ce cas, la condition partirait
      -- en NULL et ferait tomber la ligne entière.
      AND (ot.id IS NULL OR ou.id IS NULL OR ${visibleAuthorSql('ou')})
  `, {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });

  // Construire un map id → row
  const byId = {};
  for (const row of rows) {
    byId[row.id] = row;
  }

  // Préserver l'ordre Rust
  const tweets = [];
  for (const id of tweetIds) {
    const row = byId[id];
    if (!row) continue;

    const isRetweet = Boolean(row.is_retweet) || row.tweet_type === 'retweet';
    const originalTweet = row.original_id && row.original_author_id ? {
      id: String(row.original_id),
      content: row.original_content || '',
      created_at: row.original_created_at,
      is_retweet: Boolean(row.original_is_retweet),
      is_quote: Boolean(row.original_is_quote),
      tweet_type: row.original_tweet_type || 'tweet',
      parent_tweet_id: row.original_parent_tweet_id || null,
      original_tweet_id: row.original_original_tweet_id || null,
      media_urls: row.original_media_urls || [],
      hashtags: row.original_hashtags || [],
      mentions: row.original_mentions || [],
      translation_enabled: Boolean(row.original_translation_enabled),
      author: {
        id: String(row.original_author_id),
        username: row.original_author_username,
        full_name: row.original_author_full_name || row.original_author_username,
        avatar: row.original_author_avatar || null,
        verified: Boolean(row.original_author_verified),
        verification_style: row.original_author_verification_style || 'default',
        premium: Boolean(row.original_author_premium),
        subscription_tier: row.original_author_subscription_tier || 'free',
        profile_customization: row.original_author_profile_customization || {},
        stats: {},
      },
    } : null;

    // Un retweet pur n'a pas de contenu propre : sans original exploitable il
    // produirait une carte entièrement vide dans les clients.
    if (isRetweet && !originalTweet) continue;
    if (isRetweet && originalTweet?.parent_tweet_id) continue;

    const isReply = Boolean(row.parent_tweet_id);
    const parentTweet = row.parent_id && row.parent_author_id ? {
      id: String(row.parent_id),
      content: row.parent_content || '',
      created_at: row.parent_created_at,
      media_urls: row.parent_media_urls || [],
      author: {
        id: String(row.parent_author_id),
        username: row.parent_author_username,
        full_name: row.parent_author_full_name || row.parent_author_username,
        avatar: row.parent_author_avatar || null,
        verified: Boolean(row.parent_author_verified),
        verification_style: row.parent_author_verification_style || 'default',
        premium: Boolean(row.parent_author_premium),
        subscription_tier: row.parent_author_subscription_tier || 'free',
        profile_customization: row.parent_author_profile_customization || {},
        stats: {},
      },
    } : null;
    // Une réponse dont le parent est supprimé/privé/non modéré n'a pas de
    // contexte affichable : elle flotterait sans ancrage dans le fil.
    if (isReply && !parentTweet) continue;

    const ownMedia = Array.isArray(row.media_urls) ? row.media_urls : [];
    const originalMedia = Array.isArray(originalTweet?.media_urls) ? originalTweet.media_urls : [];
    const hasRenderableContent = Boolean(String(row.content || '').trim())
      || ownMedia.length > 0
      || Boolean(String(originalTweet?.content || '').trim())
      || originalMedia.length > 0;
    if (!hasRenderableContent) continue;

    const assignment = assignmentByTweet.get(String(row.id));
    tweets.push({
      id: String(row.id),
      content: assignment?.content || row.content || '',
      created_at: row.created_at,
      is_retweet: row.is_retweet || false,
      is_quote: row.is_quote || false,
      tweet_type: row.tweet_type || 'tweet',
      parent_tweet_id: row.parent_tweet_id || null,
      original_tweet_id: row.original_tweet_id || null,
      originalTweet,
      parentTweet,
      media_urls: row.media_urls || [],
      hashtags: row.hashtags || [],
      mentions: row.mentions || [],
      // Sans ce champ, le fil NeuralRank n'affiche jamais la traduction : ce
      // constructeur part d'une ligne SQL, pas d'une instance Sequelize.
      translation_enabled: Boolean(row.translation_enabled),
      author: {
        id: String(row.author_id),
        username: row.author_username,
        full_name: row.author_full_name || row.author_username,
        avatar: row.author_avatar || null,
        verified: row.author_verified || false,
        verification_style: row.author_verification_style || 'default',
        premium: row.author_premium || false,
        subscription_tier: row.author_subscription_tier || 'free',
        profile_customization: row.author_profile_customization || {},
        stats: {},
      },
      stats: {
        likes: Number(row.likes_count),
        retweets: Number(row.retweets_count),
        replies: Number(row.replies_count),
        views: Number(row.views_count),
      },
      user_interaction: {
        is_liked: Boolean(row.is_liked),
        is_retweeted: Boolean(row.is_retweeted),
      },
      ...(assignment ? {
        ab_test: {
          experiment_id: String(assignment.experiment_id),
          variant_id: String(assignment.variant_id),
          variant_label: String(assignment.variant_label || ''),
          status: assignment.status === 'completed' ? 'completed' : 'active',
          is_winner: Boolean(assignment.is_winner),
        },
      } : {}),
    });
  }

  // `minGap = 0` : l'espacement des fils est décidé par le recommandeur, qui
  // plafonne déjà les réponses à 25 % du feed (`MAX_REPLY_RATIO`) et connaît
  // les scores. Réappliquer un écart ici écarterait des réponses qu'il a
  // délibérément placées, sans rien savoir de ce qui a motivé leur place. Ce
  // qui reste à l'API est l'INVARIANT — aucune réponse sans son parent
  // au-dessus — parce qu'il doit tenir même quand le feed vient d'ailleurs.
  return withThreadContext(spaceOutReplies(tweets, 0));
}

/**
 * Annote chaque réponse de son fil, et retire le contexte devenu redondant.
 *
 * Deux façons d'afficher une réponse coexistent dans les clients :
 *   * le fil PLAT — le parent est une ligne du feed, juste au-dessus (mobile,
 *     via `isThreadParent`/`isThreadChild`) ;
 *   * la carte de CONTEXTE — le parent est dessiné dans la carte de la réponse
 *     (Windows, via `parentTweet` et `FeedReplyThread`).
 *
 * Depuis que le recommandeur sert le parent comme une entrée à part entière,
 * les deux se déclenchent en même temps et Windows affiche le même tweet deux
 * fois : une fois en ligne, une fois enchâssé. On retire donc `parentTweet`
 * quand le parent est déjà à l'écran juste au-dessus — il n'est pas perdu, il
 * est simplement rendu par la ligne précédente, avec ses vraies statistiques.
 *
 * `parentTweet` reste servi dans le cas inverse (parent hors page), où c'est la
 * seule façon de donner son contexte à la réponse.
 */
function withThreadContext(feed) {
  const rootOf = new Map();
  const depthOf = new Map();

  return feed.map((tweet, index) => {
    const parentId = tweet.parent_tweet_id ? String(tweet.parent_tweet_id) : null;
    if (!parentId) return tweet;

    const previous = feed[index - 1];
    const parentIsAdjacent = Boolean(previous) && String(previous.id) === parentId;
    if (!parentIsAdjacent) return tweet;

    const root = rootOf.get(parentId) || parentId;
    const depth = (depthOf.get(parentId) || 0) + 1;
    rootOf.set(String(tweet.id), root);
    depthOf.set(String(tweet.id), depth);

    return {
      ...tweet,
      parentTweet: null,
      thread: { parent_id: parentId, root_id: root, depth },
    };
  });
}


/**
 * GET /api/neural-rank/recommendations
 *
 * Query params :
 *   mode    = feed | discover | trending | for_you (défaut: for_you)
 *   limit   = nombre de tweets (défaut: 50, max: 200)
 *   offset  = pagination (défaut: 0)
 */
/**
 * Hydrate les COMPTES promus en entrées de fil.
 *
 * Une publicité de compte n'a pas de tweet à afficher : ce qui est servi est
 * une carte de profil (avatar, bio, abonnés), pas un post. Elle voyage
 * néanmoins dans le même tableau que les tweets, avec `author` renseigné :
 * un client qui ne connaît pas encore les comptes promus la traite alors
 * comme une entrée sans contenu et l'ignore, plutôt que de planter.
 *
 * L'`id` définitif est posé par `injectAds` à partir de l'identifiant de la
 * publicité : deux campagnes visant le même compte resteraient sinon
 * indiscernables pour un `keyExtractor` côté client.
 */
async function fetchPromotedAccounts(userIds, readerId) {
  const safeIds = [...new Set(userIds.map(String))].filter(id => UUID_RE.test(id));
  if (safeIds.length === 0) return new Map();

  const rows = await sequelize.query(`
    SELECT u.id, u.username, u.full_name, u.avatar, u.banner, u.bio,
           u.verified, u.verification_style, u.premium,
           u.subscription_tier, u.profile_customization, u.created_at,
           (SELECT COUNT(*) FROM user_follows f
             WHERE f.following_id = u.id AND f.status = 'active')::int AS followers_count,
           (SELECT COUNT(*) FROM tweets t
             WHERE t.user_id = u.id AND t.deleted_at IS NULL)::int AS tweets_count,
           EXISTS (SELECT 1 FROM user_follows f2
                    WHERE f2.follower_id = :readerId AND f2.following_id = u.id
                      AND f2.status = 'active') AS is_following
    FROM users u
    WHERE u.id IN (:ids)`,
    { replacements: { ids: safeIds, readerId }, type: QueryTypes.SELECT });

  return new Map(rows.map(r => {
    const account = {
      id: String(r.id),
      username: r.username,
      full_name: r.full_name || r.username,
      avatar: r.avatar || null,
      banner: r.banner || null,
      bio: r.bio || '',
      verified: Boolean(r.verified),
      verification_style: r.verification_style || 'default',
      premium: Boolean(r.premium),
      subscription_tier: r.subscription_tier || 'free',
      profile_customization: r.profile_customization || {},
      stats: {
        followers: Number(r.followers_count) || 0,
        tweets: Number(r.tweets_count) || 0,
      },
    };
    return [String(r.id), {
      id: `promoted:${r.id}`, // remplacé par `promoted:<advertisement_id>` à l'insertion
      // La bio sert de contenu : c'est ce que le compte dit de lui-même, et
      // rien n'est inventé pour remplir la carte.
      content: r.bio || '',
      created_at: r.created_at,
      author: account,
      promoted_account: { ...account, is_following: Boolean(r.is_following) },
      stats: { likes: 0, retweets: 0, replies: 0, views: 0 },
      media_urls: [],
      hashtags: [],
      mentions: [],
      user_interaction: { is_liked: false, is_retweeted: false },
    }];
  }));
}

/**
 * Insère les publicités choisies par le moteur dans la page déjà hydratée.
 *
 * Les positions viennent du moteur et sont appliquées de la fin vers le
 * début : insérer par index croissant décalerait chaque position suivante
 * d'un cran à chaque insertion, et les publicités glisseraient vers le bas.
 *
 * L'impression est enregistrée côté API et pas côté moteur : c'est elle qui
 * débite l'annonceur (`adService.recordImpression`), et une écriture d'argent
 * n'a rien à faire sur le chemin chaud du classement. Un échec ici ne casse
 * jamais le fil — le lecteur n'a pas à payer l'erreur d'une régie.
 */
async function injectAds(tweets, placements, userId) {
  if (!Array.isArray(placements) || placements.length === 0) return;

  const tweetPlacements = placements.filter(p => p.target_type !== 'profile' && p.tweet_id);
  const profilePlacements = placements.filter(p => p.target_type === 'profile' && p.target_user_id);

  let byId = new Map();
  if (tweetPlacements.length > 0) {
    try {
      const adTweets = await fetchTweetsByIds(tweetPlacements.map(p => p.tweet_id), userId);
      byId = new Map(adTweets.map(t => [String(t.id), t]));
    } catch (e) {
      logger.warn(`[NeuralRank] hydratation des publicités impossible: ${e.message}`);
    }
  }

  let accountById = new Map();
  if (profilePlacements.length > 0) {
    try {
      accountById = await fetchPromotedAccounts(profilePlacements.map(p => p.target_user_id), userId);
    } catch (e) {
      logger.warn(`[NeuralRank] hydratation des comptes promus impossible: ${e.message}`);
    }
  }

  const ordered = [...placements].sort((a, b) => b.position - a.position);
  const shown = [];
  for (const p of ordered) {
    const item = p.target_type === 'profile'
      ? accountById.get(String(p.target_user_id))
      : byId.get(String(p.tweet_id));
    if (!item) {
      logger.warn(`[NeuralRank] publicité ${p.advertisement_id} non hydratable — non affichée, non facturée`);
      continue;
    }
    const pos = Math.min(Math.max(0, p.position), tweets.length);
    tweets.splice(pos, 0, {
      ...item,
      // Un tweet promu garde son propre id : c'est lui qu'on aime, ouvre ou
      // retweete. Un compte promu n'en a pas — on l'identifie par la campagne,
      // pour que deux campagnes visant le même compte restent distinctes.
      ...(p.target_type === 'profile' ? { id: `promoted:${p.advertisement_id}` } : {}),
      is_ad: true,
      ad_data: {
        id: p.advertisement_id,
        match_score: p.match_score,
        target_type: p.target_type || 'tweet',
        // Le tweet promu ré-utilise son id réel comme clé de liste — voir plus
        // haut — donc rien ici ne le redit. Ce champ existe pour le client :
        // c'est ce qu'il faut ouvrir au clic, sans avoir à deviner que
        // `tweet.id` EST déjà le bon id pour ce cas précis.
        tweet_id: p.target_type === 'profile' ? null : p.tweet_id,
      },
    });
    shown.push(p);
  }

  // Facturer UNIQUEMENT ce qui a réellement été inséré dans la page. Facturer
  // sur la seule décision du moteur revenait à débiter l'annonceur pour une
  // publicité que personne n'a vue, dès que l'hydratation échouait.
  for (const p of shown) {
    adService
      .recordImpression(p.advertisement_id, userId, { surface: 'neural_rank' })
      .catch(e => logger.warn(`[NeuralRank] impression pub non enregistrée: ${e.message}`));
  }
}

router.get('/recommendations', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { mode = 'for_you', limit = 50, offset = 0, force_refresh, exclude_seen } = req.query;
  const limitInt = Math.min(parseInt(limit) || 50, 200);
  const offsetInt = parseInt(offset) || 0;
  // Uniquement envoyé par l'onglet Explorer au rafraîchissement (voir
  // `ExploreGrid`/`fetchExplore` côté mobile) : ignore le cache Rust
  // `trending` (jusqu'à 60 s) ET le cache de cette route, pour que
  // « actualiser » change vraiment le feed au lieu de resservir le même
  // classement. Absent partout ailleurs, donc sans effet sur les autres modes.
  const forceRefresh = force_refresh === 'true' || force_refresh === '1';
  // Écarte ce que ce lecteur a déjà vu dans les dernières 24 h (set Redis
  // `twitninf:seen:<user>`). Comme `force_refresh`, envoyé par la seule page
  // Explorer : c'est elle qui doit être neuve à chaque visite, alors que le fil
  // et « Pour toi » assument de resservir un tweet manqué.
  const excludeSeen = exclude_seen === 'true' || exclude_seen === '1';

  // Deux clients qui n'ont pas les mêmes expériences ne doivent PAS partager
  // une réponse cachée, sinon l'affectation fuit de l'un à l'autre. D'où la
  // présence de ce drapeau dans la clé de cache.
  //
  // Windows était seul dans la population de test, ce qui condamnait chaque
  // expérience à converger sur une poignée de lecteurs — le mobile est le gros
  // du trafic. Il y entre désormais, mais derrière `fil.abtest` : un test A/B
  // remplace le texte du tweet par une variante, donc ça s'ouvre par paliers,
  // pas d'un coup sur tout le parc.
  //
  // Le drapeau est évalué sur `user_id` : un même lecteur reste du même côté
  // de la barrière d'une session à l'autre, sans quoi il verrait le tweet
  // changer de formulation à chaque rafraîchissement.
  const enableExperiments = req.headers['x-twitninf-client'] === 'windows-electron'
    || await featureFlagService.isEnabled('fil.abtest', { user_id: userId });

  try {
    let refusedByPaidContent = false;
    const producer = async () => {
        const result = await rustClient.getRecommendations(userId, {
          mode,
          limit: limitInt,
          offset: offsetInt,
          enableExperiments,
          forceRefresh,
          excludeSeen,
        });

        logger.info(`[NeuralRank] user=${userId} mode=${mode} count=${result.count} latency=${result.latencyMs}ms cache=${result.cacheHit}`);

        // Hydrater les IDs en tweets complets
        const tweets = await fetchTweetsByIds(result.tweetIds, userId, result.experiments);

        // ── Publicités ciblées ────────────────────────────────────────────
        // Le moteur a déjà décidé QUI voit QUOI, à partir du profil lecteur
        // qu'il construit de toute façon (vecteur de goût, heures actives,
        // graphe social) — voir `rust-recommender/src/ads/serving.rs`. Ici on
        // ne fait qu'hydrater et facturer.
        //
        // C'est ce fil-ci qui manquait : l'injection n'existait que dans
        // `recommendationRoutes.js`, l'ancien fil, via l'ancien module de
        // ciblage SQLite. Les publicités créées en base n'étaient donc
        // affichées nulle part.
        await injectAds(tweets, result.ads, userId);

        // Contenus payants : ce fil est construit à partir d'IDs classés par le
        // service Rust, qui ne sait rien des verrous. Le masquage se fait donc ici,
        // juste avant l'envoi, comme sur toutes les autres listes — et surtout
        // AVANT la mise en cache, pour qu'une charge cachée soit déjà masquée.
        if (!(await paidContentService.maskTweetsOrFail(tweets, userId, res))) {
          refusedByPaidContent = true;
          return null;
        }

        // Score et confiance du moteur, restreints aux tweets RÉELLEMENT
        // servis : l'hydratation en perd (tweet supprimé entre le classement
        // et la lecture) et l'injection publicitaire en ajoute qui n'en ont
        // pas. Relayer la liste brute enverrait des lignes qui ne
        // correspondent à rien à l'écran.
        //
        // C'est construit ICI, dans le `producer`, et donc AVANT
        // `withFeedCache` : attacher les scores après la mise en cache
        // servirait une charge cachée sans eux, et la question explicite
        // resterait muette pour tout lecteur tombant sur un cache chaud —
        // c'est-à-dire presque tout le monde.
        const servedIds = new Set(tweets.map((t) => String(t?.id)));
        const scores = result.scores.filter((s) => servedIds.has(String(s?.tweet_id)));

        return {
          success: true,
          engine: 'rust-neural-rank',
          data: {
            recommendations: tweets,
            scores,
            count: tweets.length,
            algorithm: result.algorithm,
            latency_ms: result.latencyMs,
            cache_hit: result.cacheHit,
            pagination: {
              limit: limitInt,
              offset: offsetInt,
              hasMore: result.count >= limitInt,
              total: result.count,
            },
          },
        };
      };

    const payload = forceRefresh
      ? await producer()
      : (await withFeedCache(
          // `seen` fait partie de la clé : deux appels qui ne demandent pas le
          // même filtrage ne doivent pas se partager une charge cachée.
          { scope: 'neural', userId, params: { mode, limit: limitInt, offset: offsetInt, exp: enableExperiments ? 1 : 0, seen: excludeSeen ? 1 : 0 } },
          producer
        )).payload;

    if (refusedByPaidContent) return;
    return res.json(payload);
  } catch (err) {
    // Plus de repli JS : le fil « Pour toi » n'a qu'une seule source de
    // classement (le service Rust). Un repli silencieux servait un contenu
    // dégradé (auteurs sans personnalisation de profil, réponses exclues,
    // graphe social ignoré) sans que rien ne le signale à l'utilisateur — la
    // panne se voit désormais au lieu de se déguiser en fil normal.
    logger.error(`[NeuralRank] Rust service unavailable (${err.message})`);
    return res.status(503).json({ success: false, error: 'Service de recommandation temporairement indisponible' });
  }
});

/**
 * POST /api/neural-rank/track
 *
 * Body :
 *   tweetId        {number}
 *   interactionType {string}  — 'like', 'comment', 'retweet', 'share', 'view', 'skip', 'report', 'block', 'bookmark'
 *   dwellMs        {number?}  — temps en ms passé sur le contenu
 */
router.post('/track', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const {
    tweetId, interactionType, dwellMs, experimentId, variantId,
    dwellMedia, contentChars, videoDurationMs, authorId,
  } = req.body;

  if (!tweetId || !interactionType) {
    return res.status(400).json({ success: false, error: 'tweetId et interactionType sont requis' });
  }

  const typeMap = {
    tweet_like: 'like', like: 'like',
    tweet_unlike: 'unlike', unlike: 'unlike',
    tweet_comment: 'comment', comment: 'comment',
    tweet_retweet: 'retweet', retweet: 'retweet',
    tweet_unretweet: 'unretweet', unretweet: 'unretweet',
    tweet_share: 'share', share: 'share',
    tweet_view: 'view', view: 'view',
    tweet_bookmark: 'bookmark', bookmark: 'bookmark',
    profile_view: 'profile_view',
    content_skip: 'skip', skip: 'skip',
    tweet_report: 'report', report: 'report',
    user_block: 'block', block: 'block',
    // Réponses à la question posée dans le fil (« ça t'intéresse ? »).
    // Distinctes d'un like : elles portent sur le GENRE de contenu, et
    // `not_interested` met en plus l'auteur en sourdine côté moteur.
    interested: 'interested',
    not_interested: 'not_interested',
  };

  const mappedType = typeMap[interactionType];
  if (!mappedType) {
    return res.status(400).json({ success: false, error: `Type d'interaction inconnu: ${interactionType}` });
  }

  try {
    // Nature du contenu : sans elle, le moteur ne peut pas distinguer « lu en
    // entier » de « survolé », et confond le temps passé avec la longueur du
    // tweet. On ne transmet que des valeurs reconnues.
    const DWELL_MEDIA = ['text', 'image', 'video'];
    const dwellContext = DWELL_MEDIA.includes(dwellMedia)
      ? {
          media: dwellMedia,
          contentChars: Number.isFinite(Number(contentChars)) ? Math.max(0, Number(contentChars)) : 0,
          videoDurationMs: Number.isFinite(Number(videoDurationMs)) ? Math.max(0, Number(videoDurationMs)) : null,
        }
      : null;

    // Le meme temps de lecture, ecrit aussi dans `user_behavior_data` : le pot
    // createur le cherche la, et nulle part ailleurs. Sans ce miroir, aucun
    // createur n'a jamais de temps de lecture reel et le signal Attention
    // tourne en permanence sur une estimation decotee. Voir `dwellMirror.js`.
    //
    // AVANT l'appel au recommandeur, et deliberement : place apres, un Rust
    // indisponible ou en timeout faisait sauter l'execution dans le `catch` et
    // n'ecrivait rien. La paie des createurs ne doit pas dependre de la
    // disponibilite du moteur de classement.
    //
    // Non attendu : cette route sert d'abord le classement, une ecriture lente
    // ou en echec ne doit ni la ralentir ni la faire tomber.
    mirrorDwell({
      userId,
      tweetId,
      action: mappedType,
      dwellMs,
      context: dwellContext,
      ip: req.ip,
    }).catch(() => {});

    // Auteur resolu en base quand le client ne le joint pas : sans lui, le
    // filtrage collaboratif, le boost temps reel et le bandit d'exploration ne
    // se declenchent jamais (voir `services/interactionAuthor`). Le repli
    // profite au parc deja installe, qui ne l'envoie sur aucun geste.
    const resolvedAuthorId = await coalesceAuthorId(authorId, tweetId);

    const result = await rustClient.trackInteraction(
      userId,
      tweetId,
      mappedType,
      dwellMs || null,
      experimentId && variantId
        ? { experiment_id: experimentId, variant_id: variantId }
        : null,
      dwellContext,
      resolvedAuthorId,
    );

    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[NeuralRank] Track error: ${err.message}`);
    return res.json({ success: true, data: { tracked: false, reason: 'service_unavailable' } });
  }
});

/**
 * POST /api/neural-rank/on-publish
 *
 * Appelé après la publication d'un tweet.
 * Invalide les caches trending/discover NeuralRank pour que le nouveau tweet
 * apparaisse rapidement dans les fils des autres utilisateurs.
 *
 * Body : { tweetId: string }
 */
router.post('/on-publish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tweetId } = req.body;

  logger.info(`[NeuralRank] on-publish user=${userId} tweet=${tweetId}`);

  // Invalider le cache NeuralRank de l'auteur (ses propres recos)
  try {
    await rustClient.invalidateUser(userId);
  } catch { /* non-fatal */ }

  // Invalider les caches trending et discover pour tous les users via Redis
  try {
    const rc = await getRedisClient();
    // SCAN + DEL sur twitninf:reco:*:trending et twitninf:reco:*:discover
    for (const pattern of ['twitninf:reco:*:trending', 'twitninf:reco:*:discover', 'twitninf:reco:*:for_you']) {
      const keys = await rc.keys(pattern);
      if (keys.length > 0) {
        await rc.del(keys);
        logger.info(`[NeuralRank] Invalidated ${keys.length} cache keys for pattern ${pattern}`);
      }
    }
  } catch (redisErr) {
    logger.warn(`[NeuralRank] Redis invalidation failed: ${redisErr.message}`);
  }

  return res.json({ success: true, message: 'Caches NeuralRank invalidés' });
});

/**
 * GET /api/neural-rank/account-status
 *
 * État de distribution du compte appelant : avertissements actifs, motif,
 * surfaces actuellement fermées et date à laquelle la restriction s'allège.
 *
 * Toujours l'utilisateur authentifié, jamais un identifiant fourni par le
 * client : cet état dit quels avertissements pèsent sur un compte, ce qui n'a
 * pas à être lisible par des tiers. Le moteur Rust n'a aucun moyen de vérifier
 * de qui vient la demande — c'est ici que ça se joue.
 *
 * L'intérêt de l'exposer plutôt que de le garder silencieux : un compte qui ne
 * peut ni voir ni dater sa restriction ne la corrige pas. C'est le constat qui
 * a conduit TikTok à doubler son système de sanctions d'une page « état du
 * compte » au lieu de le laisser deviner.
 */
router.get('/account-status', authenticateToken, async (req, res) => {
  try {
    const status = await rustClient.getAccountStatus(req.user.id);
    return res.json({ success: true, data: status });
  } catch (err) {
    logger.warn(`[NeuralRank] account-status indisponible: ${err.message}`);
    // Le moteur est injoignable : on ne peut pas conclure que le compte est
    // sain, seulement qu'on ne sait pas. Le dire, plutôt que d'afficher un
    // « tout va bien » inventé.
    return res.status(503).json({
      success: false,
      error: 'État du compte temporairement indisponible',
    });
  }
});

/**
 * POST /api/neural-rank/calibration/round
 *
 * Un tour de la page « Recalibrer l'algorithme » (Paramètres — jamais proposée
 * automatiquement). Body :
 *   round            {number}   — 1 à 5
 *   likedTweetIds    {string[]} — cumulés depuis le tour 1 de CETTE session
 *   skippedTweetIds  {string[]} — idem, côté rejetés
 */
router.post('/calibration/round', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // Borne large à dessein : c'est le client qui décide du nombre de tours
  // (c'est lui qui appelle `/finish`), et une app déjà installée ne se met
  // pas à jour en même temps que le serveur. Une borne serrée ici rejetait
  // le dernier tour de tout client encore réglé sur l'ancien compte — voir
  // `MAX_ACCEPTED_ROUND` côté moteur, qui applique la même tolérance.
  const round = parseInt(req.body?.round, 10);
  if (!Number.isInteger(round) || round < 1 || round > 10) {
    return res.status(400).json({ success: false, error: 'round doit être un entier entre 1 et 10' });
  }
  const likedTweetIds = Array.isArray(req.body?.likedTweetIds) ? req.body.likedTweetIds.map(String) : [];
  const skippedTweetIds = Array.isArray(req.body?.skippedTweetIds) ? req.body.skippedTweetIds.map(String) : [];

  try {
    const tweetIds = await rustClient.getCalibrationRound(userId, round, likedTweetIds, skippedTweetIds);
    // Même hydratation que le fil normal : la carte de recalibration doit
    // pouvoir s'afficher avec le même composant que n'importe quel tweet.
    const tweets = await fetchTweetsByIds(tweetIds, userId);
    if (!(await paidContentService.maskTweetsOrFail(tweets, userId, res))) return;

    return res.json({ success: true, data: { round, tweets } });
  } catch (err) {
    logger.error(`[NeuralRank] calibration/round indisponible: ${err.message}`);
    return res.status(503).json({ success: false, error: 'Recalibration temporairement indisponible' });
  }
});

/**
 * POST /api/neural-rank/calibration/finish
 *
 * Termine une session de recalibration. Body : likedTweetIds {string[]} — tous
 * les choix, tous tours confondus. N'écrit AUCUN like public (voir
 * `calibration.rs`) : seul l'algorithme en tient compte.
 */
router.post('/calibration/finish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const likedTweetIds = Array.isArray(req.body?.likedTweetIds) ? req.body.likedTweetIds.map(String) : [];

  try {
    const applied = await rustClient.finishCalibration(userId, likedTweetIds);
    // Le moteur Rust invalide déjà son propre cache (profil + liste classée),
    // mais ce cache-ci (`withFeedCache`, 30s) est un étage au-dessus et ne le
    // sait pas : sans ce second appel, une recalibration resterait invisible
    // jusqu'à 30s de plus après que le moteur ait fini de la traiter.
    await require('../services/feedCache')
      .invalidateUserFeed(userId)
      .catch((e) => logger.warn(`[NeuralRank] invalidation feedCache après calibration en échec: ${e.message}`));
    return res.json({ success: true, data: { applied } });
  } catch (err) {
    logger.error(`[NeuralRank] calibration/finish indisponible: ${err.message}`);
    return res.status(503).json({ success: false, error: 'Recalibration temporairement indisponible' });
  }
});

/**
 * GET /api/neural-rank/health
 */
router.get('/health', authenticateToken, async (req, res) => {
  const status = await rustClient.healthCheck();
  const code = status.healthy ? 200 : 503;
  return res.status(code).json({ success: true, data: status });
});

module.exports = router;
