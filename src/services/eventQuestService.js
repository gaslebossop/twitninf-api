/**
 * Le moteur de quêtes des événements.
 *
 * ── Le principe : la progression est DÉRIVÉE, jamais stockée ──────────────
 * L'ancien système tenait un compteur `progress` en base. Il fallait donc
 * penser à l'incrémenter partout où l'app publie un tweet, pose un like ou
 * fait un virement — et cinq routes `update-*-progress`, appelables par le
 * client, existaient pour rattraper les oublis. Un oubli et la quête ne
 * bougeait plus ; un client malveillant et elle bougeait trop.
 *
 * Ici, rien n'est incrémenté. On RECOMPTE depuis les tables qui font déjà
 * autorité (`tweets`, `tweet_likes`, `transactions`), au moment de la lecture
 * et à nouveau au moment de la remise. Trois conséquences :
 *
 *  - aucun point du code existant n'a été touché : publier un tweet reste
 *    publier un tweet, et rien ne peut casser de ce côté ;
 *  - la progression ne peut pas dériver de la réalité ;
 *  - aucun appel client ne peut la faire avancer.
 *
 * Le prix est une poignée de `COUNT` par lecture. Le client sonde toutes les
 * cinq minutes, les colonnes portent déjà leurs index, et le comptage global
 * (le seul coûteux) est mémoïsé une minute.
 *
 * ── Comment une quête dit comment on la mesure ────────────────────────────
 * Chaque quête porte un descripteur `measure` dans sa définition JSONB. Le
 * moteur ne connaît donc AUCUN identifiant de quête en dur : ajouter une quête
 * à un futur événement ne demande pas de toucher à ce fichier, tant qu'elle se
 * mesure avec l'une des sources ci-dessous.
 */

const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize,
  Tweet,
  TweetLike,
  Transaction,
  TwEvent,
  TwQuestClaim,
  TwQuestSignal,
  User,
} = require('../models');
const logger = require('../utils/logger');
const EconomyLedger = require('../economy/ledger');
const VirtualCurrencyService = require('./virtualCurrencyService');

/** Mémoïsation du comptage global, qui est le seul à balayer toute la table. */
const globalCache = new Map();
const GLOBAL_CACHE_MS = 60 * 1000;

function windowOf(event, quest) {
  // Une quête peut resserrer la fenêtre de l'événement (`timed`), jamais
  // l'élargir : sinon « à minuit pile » se gagnerait toute la semaine.
  const from = quest?.window?.from ? new Date(quest.window.from) : new Date(event.starts_at);
  const to = quest?.window?.to ? new Date(quest.window.to) : new Date(event.ends_at);
  return { from, to };
}

function between(from, to) {
  return { [Op.gte]: from, [Op.lte]: to };
}

// ─── Sources de mesure ───────────────────────────────────────────────────────

/** Tweets publiés par le compte, éventuellement filtrés sur un hashtag. */
async function countTweets(userId, from, to, measure) {
  const where = {
    user_id: userId,
    created_at: between(from, to),
    // Un retweet n'est pas une publication : le compter permettrait de finir
    // « publie un tweet » sans jamais écrire une ligne.
    is_retweet: false,
  };

  if (measure.hashtag) {
    // `hashtags` est en JSONB. On compare en minuscules des deux côtés, sinon
    // #JoyeuxTwitninf et #joyeuxtwitninf comptent pour deux choses
    // différentes — et c'est l'utilisateur qui décide de la casse.
    where[Op.and] = literal(
      // `hashtags` n'est PAS qualifié par un alias : selon qu'on passe par
      // `count` ou `findAll`, Sequelize nomme la table « Tweet » ou « tweets »,
      // et une qualification en dur casse dans l'un des deux cas. Il n'y a
      // qu'une table dans ces requêtes, donc la colonne nue est sans ambiguïté.
      `EXISTS (SELECT 1 FROM jsonb_array_elements_text(hashtags) AS h
               WHERE lower(h) = lower(${sequelize.escape(String(measure.hashtag).replace(/^#/, ''))}))`
    );
  }

  return Tweet.count({ where });
}

/** Likes POSÉS par le compte. */
function countLikesGiven(userId, from, to) {
  return TweetLike.count({ where: { user_id: userId, created_at: between(from, to) } });
}

/**
 * Comptes DISTINCTS ayant aimé un tweet du compte.
 *
 * Le distinct est ce qui fait tenir la quête : sans lui, un seul complice qui
 * aime et retire son like en boucle suffirait à la terminer.
 */
async function countDistinctLikers(userId, from, to, measure) {
  const tweetWhere = {
    user_id: userId,
    created_at: between(from, to),
    is_retweet: false,
  };
  if (measure.hashtag) {
    tweetWhere[Op.and] = literal(
      // `hashtags` n'est PAS qualifié par un alias : selon qu'on passe par
      // `count` ou `findAll`, Sequelize nomme la table « Tweet » ou « tweets »,
      // et une qualification en dur casse dans l'un des deux cas. Il n'y a
      // qu'une table dans ces requêtes, donc la colonne nue est sans ambiguïté.
      `EXISTS (SELECT 1 FROM jsonb_array_elements_text(hashtags) AS h
               WHERE lower(h) = lower(${sequelize.escape(String(measure.hashtag).replace(/^#/, ''))}))`
    );
  }

  const tweets = await Tweet.findAll({ where: tweetWhere, attributes: ['id'], raw: true });
  if (tweets.length === 0) return 0;

  const rows = await TweetLike.findAll({
    where: {
      tweet_id: { [Op.in]: tweets.map((t) => t.id) },
      // On ne se compte pas soi-même : aimer son propre tweet ne prouve rien.
      user_id: { [Op.ne]: userId },
      created_at: between(from, to),
    },
    attributes: [[fn('COUNT', fn('DISTINCT', col('user_id'))), 'n']],
    raw: true,
  });
  return Number(rows?.[0]?.n || 0);
}

/** Destinataires DISTINCTS d'un virement émis par le compte. */
async function countDistinctTransferTargets(userId, from, to) {
  const rows = await Transaction.findAll({
    where: {
      fromUserId: userId,
      type: 'TRANSFER',
      toUserId: { [Op.ne]: userId },
      createdAt: between(from, to),
    },
    attributes: [[fn('COUNT', fn('DISTINCT', col('to_user_id'))), 'n']],
    raw: true,
  });
  return Number(rows?.[0]?.n || 0);
}

/** Signaux de navigation distincts, remontés par le client. */
async function countSignals(userId, eventSlug, questId) {
  return TwQuestSignal.count({
    where: { user_id: userId, event_slug: eventSlug, quest_id: questId },
  });
}

/**
 * Jours calendaires distincts où le compte s'est manifesté.
 *
 * « Manifesté » = un tweet OU un like. Exiger de publier tous les jours rend
 * la série inatteignable pour qui lit sans écrire, c'est-à-dire la majorité.
 *
 * ⚠️ Le regroupement se fait dans le fuseau de l'événement, pas en UTC : sans
 * `AT TIME ZONE`, un tweet posté à 23 h 30 à Paris tomberait le lendemain et
 * la série se casserait toute seule.
 */
async function countActiveDays(userId, from, to, timezone) {
  const tz = sequelize.escape(timezone || 'Europe/Paris');
  const [rows] = await sequelize.query(
    `SELECT COUNT(DISTINCT d) AS n FROM (
       SELECT date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS d
         FROM tweets
        WHERE user_id = :userId AND created_at BETWEEN :from AND :to AND deleted_at IS NULL
       UNION
       SELECT date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS d
         FROM tweet_likes
        WHERE user_id = :userId AND created_at BETWEEN :from AND :to
     ) AS days`,
    { replacements: { userId, from, to }, type: sequelize.QueryTypes.SELECT }
  );
  return Number(rows?.n || 0);
}

/** Objectif commun : le compteur est celui de TOUTE l'app. */
async function countGlobalTweets(from, to) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  const hit = globalCache.get(key);
  if (hit && Date.now() - hit.at < GLOBAL_CACHE_MS) return hit.value;

  const value = await Tweet.count({
    where: { created_at: between(from, to), is_retweet: false },
  });
  globalCache.set(key, { value, at: Date.now() });
  return value;
}

// ─── Mesure ──────────────────────────────────────────────────────────────────

/**
 * La progression d'UNE quête. Renvoie toujours un nombre, jamais une erreur :
 * une source en panne rend 0, et l'écran affiche une quête à zéro plutôt que
 * de ne rien afficher du tout.
 */
async function measureQuest(userId, event, quest, completedIds) {
  const measure = quest.measure || {};
  const { from, to } = windowOf(event, quest);

  try {
    switch (measure.source) {
      case 'tweets':
        return await countTweets(userId, from, to, measure);
      case 'likes_given':
        return await countLikesGiven(userId, from, to);
      case 'likes_received_distinct':
        return await countDistinctLikers(userId, from, to, measure);
      case 'transfers_distinct':
        return await countDistinctTransferTargets(userId, from, to);
      case 'signals':
        return await countSignals(userId, event.slug, quest.id);
      case 'active_days':
        return await countActiveDays(userId, from, to, measure.timezone);
      case 'global_tweets':
        return await countGlobalTweets(from, to);
      case 'quests_completed':
        // Se compte sur les AUTRES quêtes, sinon elle se compterait elle-même
        // et le sommet serait atteint une quête trop tôt.
        return completedIds.filter((id) => id !== quest.id).length;
      default:
        // Une quête sans descripteur n'avance que par signal explicite. C'est
        // le cas des quêtes secrètes, dont le déclencheur est ailleurs.
        return await countSignals(userId, event.slug, quest.id);
    }
  } catch (error) {
    logger.error(`Mesure impossible pour la quete ${quest.id}:`, error);
    return 0;
  }
}

/**
 * L'état complet d'un compte sur un événement.
 *
 * Deux passes sont nécessaires : les quêtes qui se mesurent sur les autres
 * (`quests_completed`) ont besoin du résultat de la première.
 */
async function measureAll(userId, event) {
  const quests = Array.isArray(event.quests) ? event.quests : [];
  const claims = await TwQuestClaim.forUser(userId, event.slug);
  const claimedIds = new Set(claims.map((c) => c.quest_id));

  const base = quests.filter((q) => (q.measure || {}).source !== 'quests_completed');
  const derived = quests.filter((q) => (q.measure || {}).source === 'quests_completed');

  const progress = [];
  const completedIds = [];

  for (const quest of base) {
    const raw = await measureQuest(userId, event, quest, completedIds);
    const goal = Math.max(1, Number(quest.goal) || 1);
    const value = Math.min(raw, goal);
    if (value >= goal) completedIds.push(quest.id);

    progress.push({
      quest_id: quest.id,
      progress: value,
      goal,
      completed: value >= goal,
      claimed: claimedIds.has(quest.id),
      claimed_at: claims.find((c) => c.quest_id === quest.id)?.claimed_at || null,
      // Sur une quête commune, le client affiche l'avancement de tous.
      ...(quest.kind === 'collective'
        ? { community: { progress: raw, goal } }
        : {}),
    });
  }

  for (const quest of derived) {
    const goal = Math.max(1, Number(quest.goal) || 1);
    const raw = await measureQuest(userId, event, quest, completedIds);
    const value = Math.min(raw, goal);
    progress.push({
      quest_id: quest.id,
      progress: value,
      goal,
      completed: value >= goal,
      claimed: claimedIds.has(quest.id),
      claimed_at: claims.find((c) => c.quest_id === quest.id)?.claimed_at || null,
    });
  }

  return progress;
}

// ─── Remise ──────────────────────────────────────────────────────────────────

/**
 * Tire une récompense dans une table de lots.
 *
 * Le tirage a lieu ICI, à la remise, et jamais avant : c'est ce qui fait qu'un
 * paquet surprise en est un. Le client apprend son contenu par la réponse.
 */
function drawLoot(reward) {
  const pool = Array.isArray(reward.pool) ? reward.pool : [];
  if (pool.length === 0) {
    // Table vide : on ne bloque pas la remise, on retombe sur l'annonce.
    return { kind: reward.kind, label: reward.label, payload: reward.payload || {} };
  }

  const total = pool.reduce((sum, entry) => sum + (Number(entry.weight) || 1), 0);
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= Number(entry.weight) || 1;
    if (roll <= 0) return { kind: entry.kind, label: entry.label, payload: entry.payload || {} };
  }
  const last = pool[pool.length - 1];
  return { kind: last.kind, label: last.label, payload: last.payload || {} };
}

/**
 * Réclame la récompense d'une quête.
 *
 * La progression est RE-MESURÉE ici. Se fier à celle envoyée à la lecture
 * laisserait une fenêtre : lire pendant que la quête est finie, se la faire
 * retirer (un like annulé), puis réclamer.
 *
 * L'unicité de la remise est garantie par l'index unique de
 * `tw_quest_claims`, pas par le contrôle applicatif qui le précède : deux
 * requêtes simultanées passent au travers d'un `findOne` puis `create`.
 */
async function claim(userId, questId) {
  const event = await TwEvent.getCurrent();
  if (!event) return { ok: false, message: 'Aucun événement en cours' };

  const quest = (event.quests || []).find((q) => q.id === questId);
  if (!quest) return { ok: false, message: 'Quête inconnue' };

  const progress = await measureAll(userId, event);
  const state = progress.find((p) => p.quest_id === questId);

  if (!state?.completed) return { ok: false, message: 'Quête pas encore terminée' };
  if (state.claimed) return { ok: false, message: 'Récompense déjà récupérée' };

  // Les prérequis se revérifient aussi : le client les affiche, il ne les
  // applique pas.
  const done = new Set(progress.filter((p) => p.completed).map((p) => p.quest_id));
  const missing = (quest.requires || []).filter((id) => !done.has(id));
  if (missing.length > 0) return { ok: false, message: 'Une quête précédente reste à finir' };

  const reward = quest.reward || {};
  const granted = reward.kind === 'lootbox' ? drawLoot(reward) : {
    kind: reward.kind,
    label: reward.label,
    payload: reward.payload || {},
  };

  try {
    await TwQuestClaim.create({
      user_id: userId,
      event_slug: event.slug,
      quest_id: questId,
      granted,
    });
  } catch (error) {
    // Violation de l'index unique = une remise concurrente a gagné la course.
    // Ce n'est pas une erreur à remonter, c'est le comportement voulu.
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return { ok: false, message: 'Récompense déjà récupérée' };
    }
    throw error;
  }

  try {
    await grant(userId, granted);
    // Marque la dette comme honorée. Tant que `settled_at` est nul, la remise
    // est enregistrée mais rien n'a été donné — et l'index unique empêche de
    // re-réclamer. C'est exactement ce qui s'est produit pour les remises
    // faites avant que `grant()` n'accorde réellement quoi que ce soit :
    // `scripts/replayEventGrants.js` les rattrape.
    await TwQuestClaim.update(
      { settled_at: new Date() },
      { where: { user_id: userId, event_slug: event.slug, quest_id: questId } }
    );
  } catch (error) {
    // La remise est ACQUISE même si l'octroi échoue : on préfère un compte à
    // qui l'on doit 300 NF, retrouvable par `settled_at IS NULL`, plutôt
    // qu'une quête réclamable en boucle jusqu'à ce que ça marche.
    logger.error(`Octroi echoue pour ${userId} / ${questId}:`, error);
  }

  return { ok: true, granted };
}

/**
 * L'octroi effectif.
 *
 * ── D'où sortent les NF offerts ───────────────────────────────────────────
 * De la TRÉSORERIE de la plateforme, via `EconomyLedger.rewardFromTreasury` —
 * le chemin qui sert déjà aux récompenses créateur. La question « quel compte
 * débite » était en réalité déjà tranchée par l'économie de l'app : les
 * récompenses sont financées par les dépenses des utilisateurs, et le registre
 * refuse l'opération si la trésorerie est à sec plutôt que de créer de la
 * monnaie à partir de rien.
 *
 * C'est ce refus qui rend l'événement sûr : onze quêtes distribuées à des
 * milliers de comptes ne peuvent pas faire dériver la masse monétaire.
 *
 * ── Pourquoi les échecs ne remontent pas ──────────────────────────────────
 * Chaque octroi est isolé. Un badge qui échoue ne doit pas empêcher les NF
 * d'arriver, et l'appelant a DÉJÀ enregistré la réclamation — c'est
 * délibéré : mieux vaut un compte à qui l'on doit quelque chose, réparable
 * depuis `tw_quest_claims.granted`, qu'une quête réclamable en boucle jusqu'à
 * ce que ça marche.
 */
async function grant(userId, granted) {
  const payload = granted.payload || {};

  // Une récompense composite (le badge « Fondateur » porte aussi des NF, des
  // jours de Pro et un titre) déclenche plusieurs octrois. On les tente tous,
  // indépendamment.
  const jobs = [];

  if (granted.kind === 'coins' || payload.coins) {
    jobs.push(['coins', () => grantCoins(userId, Number(payload.amount ?? payload.coins), granted.label)]);
  }
  if (granted.kind === 'pro_days' || payload.pro_days) {
    jobs.push(['pro_days', () => grantProDays(userId, Number(payload.days ?? payload.pro_days))]);
  }
  if (granted.kind === 'badge' || payload.badge) {
    jobs.push(['badge', () => grantInventoryItem(userId, granted.label)]);
  }
  if (granted.kind === 'cosmetic' && payload.slot) {
    jobs.push(['cosmetic', () => grantCosmetic(userId, String(payload.slot), payload.value)]);
  }
  if (granted.kind === 'title' || payload.title) {
    jobs.push(['title', () => grantTitle(userId, String(payload.title))]);
  }
  if (granted.kind === 'multiplier') {
    jobs.push([
      'multiplier',
      () => grantMultiplier(userId, Number(payload.factor), Number(payload.hours)),
    ]);
  }

  for (const [kind, run] of jobs) {
    try {
      await run();
    } catch (error) {
      logger.error(`Octroi ${kind} echoue pour ${userId} (${granted.label}):`, error.message);
    }
  }

  if (jobs.length === 0) {
    // Il ne reste que `unlock`, qui prêterait une capacité normalement
    // payante. Rien à faire de plus que `pro_days` ne fasse déjà mieux : les
    // capacités sont gardées par `subscription_tier`, donc prêter l'accès EST
    // accorder du Pro. La trace reste dans `tw_quest_claims.granted`.
    logger.info(`Recompense ${granted.kind} enregistree sans octroi automatique: ${granted.label}`);
  }
}

/**
 * Bonus temporaire sur les gains.
 *
 * ── Pourquoi une échéance en base et pas une tâche de nettoyage ───────────
 * Un bonus expiré se lit comme absent (voir `earnMultiplierFor`), donc aucun
 * cron n'a à repasser derrière. Rien n'est à réparer si le serveur redémarre
 * au mauvais moment, et un bonus ne peut pas rester actif indéfiniment par
 * l'oubli d'une tâche planifiée.
 *
 * ── Ce qui se passe si on en gagne deux ───────────────────────────────────
 * On garde le MEILLEUR facteur et on PROLONGE l'échéance. Empiler les facteurs
 * (× 2 puis × 2 = × 4) ouvrirait une dérive : l'événement distribue le même
 * bonus à chaque compte, et rien n'empêcherait de le cumuler avec un futur.
 */
async function grantMultiplier(userId, factor, hours) {
  if (!Number.isFinite(factor) || factor <= 1) return;
  if (!Number.isFinite(hours) || hours <= 0) return;

  const user = await User.findByPk(userId);
  if (!user) throw new Error('Compte introuvable');

  const now = new Date();
  const current = user.earn_multiplier_until ? new Date(user.earn_multiplier_until) : null;
  const active = current && current > now;

  const nextFactor = active ? Math.max(Number(user.earn_multiplier) || 1, factor) : factor;
  const base = active ? current : now;
  const until = new Date(base.getTime() + hours * 60 * 60 * 1000);

  await user.update({ earn_multiplier: nextFactor, earn_multiplier_until: until });
  logger.info(`[event] bonus x${nextFactor} accorde a ${userId} jusqu'au ${until.toISOString()}`);
}

/**
 * Le facteur en vigueur pour un compte, ou 1.
 *
 * Exporté parce que c'est la monétisation des tweets qui l'applique, au seul
 * endroit où les fonds bougent réellement.
 */
async function earnMultiplierFor(userId) {
  try {
    const user = await User.findByPk(userId, {
      attributes: ['earn_multiplier', 'earn_multiplier_until'],
    });
    if (!user?.earn_multiplier_until) return 1;
    if (new Date(user.earn_multiplier_until) <= new Date()) return 1;

    const factor = Number(user.earn_multiplier);
    // Plafond de sécurité : une valeur aberrante en base ne doit pas pouvoir
    // vider la trésorerie.
    return Number.isFinite(factor) && factor > 1 ? Math.min(factor, 5) : 1;
  } catch (error) {
    // Un bonus illisible n'empêche jamais de payer le gain de base.
    logger.error('Lecture du bonus de gains impossible:', error.message);
    return 1;
  }
}

/** NF, depuis la trésorerie. Refusé si elle est insuffisante. */
async function grantCoins(userId, amount, description) {
  if (!Number.isFinite(amount) || amount <= 0) return;

  const currency = await VirtualCurrencyService.getMainCurrency();
  if (!currency) throw new Error('Monnaie principale introuvable');

  const dbTransaction = await sequelize.transaction();
  try {
    await EconomyLedger.rewardFromTreasury(
      userId,
      currency.id,
      amount,
      `Événement : ${description}`,
      dbTransaction
    );
    await dbTransaction.commit();
    logger.info(`[event] ${amount} NF accordes a ${userId}`);
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }
}

/**
 * Jours de Pro.
 *
 * On PROLONGE une échéance existante au lieu de la remplacer : quelqu'un qui
 * paie déjà son abonnement ne doit pas voir sa date reculer parce qu'il a
 * gagné sept jours.
 */
async function grantProDays(userId, days) {
  if (!Number.isFinite(days) || days <= 0) return;

  const user = await User.findByPk(userId);
  if (!user) throw new Error('Compte introuvable');

  const now = new Date();
  const current = user.subscription_expires_at ? new Date(user.subscription_expires_at) : null;
  const base = current && current > now ? current : now;
  const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  await user.update({
    subscription_tier: user.subscription_tier === 'free' ? 'pro' : user.subscription_tier,
    subscription_expires_at: until,
    premium: true,
  });
  logger.info(`[event] ${days} jours de Pro accordes a ${userId} (jusqu'au ${until.toISOString()})`);
}

/** Badge : passe par l'inventaire, comme les autres objets de compte. */
async function grantInventoryItem(userId, itemName) {
  const InventoryService = require('./inventoryService');
  const already = await InventoryService.userHasItem(userId, itemName);
  if (already) return;
  await InventoryService.addItemToUser(userId, itemName, 1);
  logger.info(`[event] objet « ${itemName} » ajoute a l'inventaire de ${userId}`);
}

/**
 * Cosmétique : écrit dans `profile_customization`, la colonne JSON que l'app
 * lit déjà pour l'habillage de profil.
 */
async function grantCosmetic(userId, slot, value) {
  const user = await User.findByPk(userId);
  if (!user) throw new Error('Compte introuvable');

  const current = user.profile_customization || {};
  // On n'ÉCRASE pas un choix existant : débloquer une police ne doit pas
  // changer celle que la personne s'est choisie. On l'ajoute aux éléments
  // possédés, et elle l'appliquera si elle le veut.
  const unlocked = Array.isArray(current.unlocked) ? current.unlocked : [];
  const token = `${slot}:${value}`;
  if (unlocked.includes(token)) return;

  await user.update({
    profile_customization: { ...current, unlocked: [...unlocked, token] },
  });
  logger.info(`[event] cosmetique ${token} debloque pour ${userId}`);
}

/** Titre de profil, dans la même colonne. */
async function grantTitle(userId, title) {
  if (!title) return;
  const user = await User.findByPk(userId);
  if (!user) throw new Error('Compte introuvable');

  const current = user.profile_customization || {};
  const titles = Array.isArray(current.titles) ? current.titles : [];
  if (titles.includes(title)) return;

  await user.update({
    profile_customization: {
      ...current,
      titles: [...titles, title],
      // Le premier titre gagné s'applique tout seul : sans cela, la
      // récompense est invisible tant qu'on n'a pas fouillé les réglages.
      profile_title: current.profile_title || title,
    },
  });
  logger.info(`[event] titre « ${title} » accorde a ${userId}`);
}

// ─── Signaux ─────────────────────────────────────────────────────────────────

/**
 * Enregistre un geste que seul le client peut constater.
 *
 * N'accorde jamais rien : incrémente un compteur, que la remise revérifiera.
 */
async function reportSignal(userId, eventSlug, questId, idempotencyKey) {
  if (!idempotencyKey) return false;
  try {
    await TwQuestSignal.create({
      user_id: userId,
      event_slug: eventSlug,
      quest_id: questId,
      idempotency_key: String(idempotencyKey).slice(0, 160),
    });
    return true;
  } catch (error) {
    // Déjà vu : c'est le fonctionnement normal de l'idempotence, pas un échec.
    if (error?.name === 'SequelizeUniqueConstraintError') return true;
    logger.error('Signal de quete refuse:', error);
    return false;
  }
}

module.exports = { measureAll, claim, reportSignal, drawLoot, earnMultiplierFor, grant };
