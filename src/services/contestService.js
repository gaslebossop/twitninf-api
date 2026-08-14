'use strict';

/**
 * Concours : vérification des conditions et tirage au sort.
 *
 * Deux invariants portés ici, pas dans les routes :
 *
 * 1. **C'est l'état au moment du TIRAGE qui compte.** Les conditions sont
 *    contrôlées une première fois à l'inscription — pour dire tout de suite
 *    au participant ce qu'il lui manque — puis intégralement recontrôlées au
 *    tirage. Sans ça, « je suis, je like, je participe, je me désabonne »
 *    serait la stratégie gagnante.
 *
 * 2. **Le tirage est reproductible.** Pas de `ORDER BY RANDOM()` : l'ordre
 *    vient de `sha256(graine + ':' + user_id)`. La graine est engagée par son
 *    empreinte dès la création, révélée seulement une fois le tirage fait.
 *    N'importe qui peut alors refaire le calcul et vérifier les gagnants.
 */

const { Op } = require('sequelize');
const logger = require('../utils/logger');

/** Durée maximale d'un concours. Au-delà, plus personne ne s'en souvient. */
const MAX_DURATION_DAYS = 30;
/** Durée minimale : le temps que le tweet soit vu par autre chose qu'un bot. */
const MIN_DURATION_MINUTES = 10;

/**
 * Devises acceptées en saisie libre : 3 à 8 caractères alphanumériques en
 * majuscules. Volontairement permissif — le concours doit pouvoir être en
 * XAF, en NF ou en n'importe quoi d'autre — mais pas au point d'accepter une
 * chaîne arbitraire qui s'afficherait n'importe comment dans la carte.
 */
const CURRENCY_RE = /^[A-Z0-9]{2,8}$/;

class ContestValidationError extends Error {
  constructor(message, code = 'CONTEST_INVALID', status = 400) {
    super(message);
    this.name = 'ContestValidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Valide et normalise ce que le client a envoyé pour créer un concours.
 * Renvoie un objet prêt à insérer, ou lève une ContestValidationError dont le
 * message est directement affichable.
 */
function normalizeCreatePayload(body = {}) {
  const Contest = require('../models/Contest');

  const amount = Number.parseFloat(body.prize_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ContestValidationError('Indique le montant mis en jeu.', 'PRIZE_REQUIRED');
  }
  if (amount > 99999999999.99) {
    throw new ContestValidationError('Le montant annoncé est trop élevé.', 'PRIZE_TOO_LARGE');
  }

  const currency = String(body.prize_currency || 'EUR').trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new ContestValidationError(
      'La devise doit être un code court en majuscules (EUR, USD, XAF, NF…).',
      'CURRENCY_INVALID'
    );
  }

  const winners = Number.parseInt(body.winners_count, 10) || 1;
  if (winners < 1 || winners > 100) {
    throw new ContestValidationError('Le nombre de gagnants doit être compris entre 1 et 100.', 'WINNERS_INVALID');
  }

  const endsAt = new Date(body.ends_at);
  if (Number.isNaN(endsAt.getTime())) {
    throw new ContestValidationError('Date de fin invalide.', 'ENDS_AT_INVALID');
  }
  const now = Date.now();
  if (endsAt.getTime() < now + MIN_DURATION_MINUTES * 60_000) {
    throw new ContestValidationError(
      `Le concours doit durer au moins ${MIN_DURATION_MINUTES} minutes.`,
      'ENDS_AT_TOO_SOON'
    );
  }
  if (endsAt.getTime() > now + MAX_DURATION_DAYS * 86_400_000) {
    throw new ContestValidationError(
      `Un concours ne peut pas durer plus de ${MAX_DURATION_DAYS} jours.`,
      'ENDS_AT_TOO_FAR'
    );
  }

  const { seed, commitment } = Contest.newSeed();

  return {
    title: body.title ? String(body.title).trim().slice(0, 120) : null,
    prize_amount: amount,
    prize_currency: currency,
    prize_note: body.prize_note ? String(body.prize_note).trim().slice(0, 160) : null,
    winners_count: winners,
    conditions: Contest.normalizeConditions(body.conditions),
    ends_at: endsAt,
    draw_seed: seed,
    seed_commitment: commitment,
  };
}

/**
 * Contrôle les conditions d'un concours pour un utilisateur.
 *
 * @returns {Promise<{ok: boolean, missing: Array<{key: string, label: string}>}>}
 *          `missing` liste ce qu'il reste à faire, en clair : l'écran de
 *          participation affiche cette liste telle quelle, donc un refus dit
 *          toujours QUOI faire et pas seulement « non ».
 */
async function checkConditions(contest, userId) {
  const models = require('../models');
  const { User, TweetLike, TweetRetweet, UserFollow, Tweet } = models;
  const conditions = contest.conditions || {};
  const missing = [];

  if (conditions.follow_creator) {
    // `status: 'active'` obligatoire : une demande de suivi en attente ou un
    // suivi rompu laisse la ligne en base, elle ne vaut pas abonnement.
    const follows = await UserFollow.findOne({
      where: { follower_id: userId, following_id: contest.creator_id, status: 'active' },
    });
    if (!follows) missing.push({ key: 'follow_creator', label: "Suivre l'organisateur" });
  }

  if (conditions.like_tweet) {
    const liked = await TweetLike.findOne({ where: { tweet_id: contest.tweet_id, user_id: userId } });
    if (!liked) missing.push({ key: 'like_tweet', label: 'Aimer le tweet du concours' });
  }

  if (conditions.retweet_tweet) {
    const retweeted = await TweetRetweet.findOne({
      where: { tweet_id: contest.tweet_id, user_id: userId },
    });
    if (!retweeted) missing.push({ key: 'retweet_tweet', label: 'Retweeter le concours' });
  }

  if (conditions.reply_tweet) {
    const replied = await Tweet.findOne({
      where: { parent_tweet_id: contest.tweet_id, user_id: userId },
    });
    if (!replied) missing.push({ key: 'reply_tweet', label: 'Répondre au tweet du concours' });
  }

  if (conditions.min_account_age_days > 0) {
    const user = await User.findByPk(userId, { attributes: ['id', 'created_at'] });
    if (!user) {
      missing.push({ key: 'account', label: 'Compte introuvable' });
    } else {
      // `createdAt` et pas `created_at` : sur une instance Sequelize, lire
      // l'attribut souligné renvoie undefined, et la comparaison passerait
      // silencieusement pour tout le monde.
      const created = user.createdAt || user.get('created_at');
      const ageDays = created ? (Date.now() - new Date(created).getTime()) / 86_400_000 : 0;
      if (ageDays < conditions.min_account_age_days) {
        missing.push({
          key: 'min_account_age_days',
          label: `Compte créé depuis au moins ${conditions.min_account_age_days} jour(s)`,
        });
      }
    }
  }

  if (conditions.min_followers > 0) {
    // Il n'y a pas de colonne `followers_count` sur `users` : le nombre
    // d'abonnés est toujours compté depuis `user_follows` dans ce projet.
    const followers = await UserFollow.count({
      where: { following_id: userId, status: 'active' },
    });
    if (followers < conditions.min_followers) {
      missing.push({
        key: 'min_followers',
        label: `Avoir au moins ${conditions.min_followers} abonné(s)`,
      });
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Tire les gagnants d'un concours échu.
 *
 * Passe d'abord le concours en `drawing` par un UPDATE conditionnel : c'est
 * ce qui empêche deux exécutions du cron (ou un cron et un appel manuel) de
 * tirer deux fois le même concours. Si l'UPDATE ne touche aucune ligne, un
 * autre l'a déjà pris en charge et on s'arrête là.
 */
async function drawContest(contestId) {
  const models = require('../models');
  const { Contest, ContestEntry, Notification, sequelize } = models;

  const [claimed] = await Contest.update(
    { status: 'drawing' },
    { where: { id: contestId, status: 'open' } }
  );
  if (claimed === 0) return null;

  const contest = await Contest.findByPk(contestId);
  if (!contest) return null;

  try {
    const entries = await ContestEntry.findAll({
      where: { contest_id: contestId },
      order: [['entered_at', 'ASC']],
    });

    // Recontrôle intégral : c'est l'état maintenant qui décide.
    const eligible = [];
    for (const entry of entries) {
      const { ok, missing } = await checkConditions(contest, entry.user_id);
      if (ok) {
        entry.status = 'eligible';
        entry.rejected_reason = null;
        eligible.push(entry);
      } else {
        entry.status = 'rejected';
        entry.rejected_reason = missing.map((m) => m.label).join(', ').slice(0, 80);
      }
    }

    // Ordre déterministe et vérifiable à partir de la graine révélée.
    const ranked = eligible
      .map((entry) => ({ entry, key: Contest.drawKey(contest.draw_seed, entry.user_id) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const winners = ranked.slice(0, contest.winners_count);
    winners.forEach((w, i) => {
      w.entry.is_winner = true;
      w.entry.rank = i + 1;
    });

    await sequelize.transaction(async (transaction) => {
      for (const entry of entries) {
        await entry.save({ transaction });
      }
      await contest.update(
        { status: 'closed', drawn_at: new Date() },
        { transaction }
      );
    });

    await notifyResults(contest, winners.map((w) => w.entry), Notification);

    logger.info(
      `[Concours] ${contestId} tiré : ${winners.length} gagnant(s) sur ${eligible.length} éligible(s) (${entries.length} participant(s))`
    );
    return { contest, winners: winners.map((w) => w.entry), eligibleCount: eligible.length };
  } catch (error) {
    // Repasser en `open` plutôt que de laisser le concours coincé en
    // `drawing` : sinon une erreur transitoire (base indisponible une
    // seconde) le condamnerait à ne plus jamais être tiré.
    await Contest.update({ status: 'open' }, { where: { id: contestId, status: 'drawing' } });
    throw error;
  }
}

/**
 * Notifie les gagnants et l'organisateur. Le type reste `system` avec un
 * sous-type dans `metadata.kind` : ajouter une valeur à l'ENUM `type` des
 * notifications imposerait une migration à toute la table.
 */
async function notifyResults(contest, winners, Notification) {
  const prize = `${contest.prize_amount} ${contest.prize_currency}`;
  try {
    for (const winner of winners) {
      await Notification.create({
        recipient_id: winner.user_id,
        sender_id: contest.creator_id,
        tweet_id: contest.tweet_id,
        type: 'system',
        title: 'Tu as gagné le concours',
        message: `Tu fais partie des gagnants du concours (${prize}).`,
        priority: 'high',
        content: { contest_id: contest.id, rank: winner.rank, prize },
        metadata: { kind: 'contest_won', contest_id: contest.id },
      });
    }
    await Notification.create({
      recipient_id: contest.creator_id,
      tweet_id: contest.tweet_id,
      type: 'system',
      title: 'Ton concours est terminé',
      message: winners.length
        ? `${winners.length} gagnant(s) tiré(s). À toi de verser ${prize}.`
        : 'Aucun participant éligible : aucun gagnant tiré.',
      priority: 'high',
      content: { contest_id: contest.id, winners: winners.length },
      metadata: { kind: 'contest_closed', contest_id: contest.id },
    });
  } catch (error) {
    // Un concours correctement tiré ne doit pas être rejoué parce que la
    // notification a échoué : le résultat est déjà en base, il s'affiche.
    logger.warn('[Concours] notifications non envoyées:', error.message);
  }
}

/** Tire tous les concours échus. Appelé par le cron. */
async function drawDueContests() {
  const { Contest } = require('../models');
  const due = await Contest.findAll({
    where: { status: 'open', ends_at: { [Op.lte]: new Date() } },
    attributes: ['id'],
    limit: 100,
  });

  let drawn = 0;
  for (const contest of due) {
    try {
      const result = await drawContest(contest.id);
      if (result) drawn += 1;
    } catch (error) {
      logger.error(`[Concours] tirage impossible pour ${contest.id}:`, error.message);
    }
  }
  return drawn;
}

module.exports = {
  ContestValidationError,
  normalizeCreatePayload,
  checkConditions,
  drawContest,
  drawDueContests,
  MAX_DURATION_DAYS,
  MIN_DURATION_MINUTES,
};
