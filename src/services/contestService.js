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
 *
 * 3. **L'argent est prélevé d'avance et ressort une seule fois.** La cagnotte
 *    quitte le portefeuille de l'organisateur à la création et attend à la
 *    trésorerie. Au tirage, chaque gagnant est crédité, et toute part non
 *    attribuée revient à l'organisateur. `escrow_status` passe de `held` à
 *    `paid`/`refunded` dans la MÊME transaction que les mouvements : c'est ce
 *    qui rend un double versement impossible, même si le cron repasse.
 */

const { Op } = require('sequelize');
const logger = require('../utils/logger');
const EconomyLedger = require('../economy/ledger');
const EconomyMetrics = require('../economy/metrics');
const { roundTWC } = require('../economy/money');
const { ultraLimit } = require('../utils/ultraGate');

/** Durée maximale d'un concours. Au-delà, plus personne ne s'en souvient. */
const MAX_DURATION_DAYS = 30;
/**
 * Ultra peut tenir un concours sur un trimestre.
 *
 * L'argument « plus personne ne s'en souvient » vaut pour un compte dont les
 * abonnés ne voient passer qu'un tweet de temps en temps. Un gros créateur
 * relance le sien à chaque publication : la mémoire du concours est entretenue
 * par sa fréquence, pas par sa durée.
 */
const MAX_DURATION_DAYS_ULTRA = 90;
/** Durée minimale : le temps que le tweet soit vu par autre chose qu'un bot. */
const MIN_DURATION_MINUTES = 10;

/** Plancher du grand livre : en dessous, `spendToTreasury` refuse. */
const MIN_PRIZE = 0.01;

class ContestValidationError extends Error {
  constructor(message, code = 'CONTEST_INVALID', status = 400) {
    super(message);
    this.name = 'ContestValidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Monnaies utilisables pour une cagnotte, avec le solde de l'utilisateur.
 *
 * Le catalogue fait autorité : NF, EUR interne et toutes les monnaies
 * communautaires actives. L'app ne propose que ça — laisser saisir un code
 * libre revenait à promettre une somme dans une devise que personne ne peut
 * verser.
 */
async function listUsableCurrencies(userId) {
  const { VirtualCurrency, UserWallet } = require('../models');

  const currencies = await VirtualCurrency.findAll({
    where: { isActive: true },
    order: [['isUserCreated', 'ASC'], ['symbol', 'ASC']],
  });

  const wallets = await UserWallet.findAll({ where: { userId } });
  const balanceByCurrency = new Map(
    wallets.map((w) => [String(w.currencyId), Number(w.balance) || 0])
  );

  return currencies.map((c) => ({
    id: c.id,
    name: c.name,
    symbol: c.symbol,
    color: c.color,
    icon: c.icon,
    // Le portefeuille n'existe qu'après un premier mouvement : pas de ligne
    // veut dire 0, pas « monnaie indisponible ».
    balance: balanceByCurrency.get(String(c.id)) ?? 0,
    is_community: !!c.isUserCreated,
    price_eur: Number(c.currentPrice) || 0,
  }));
}

/**
 * Valide et normalise ce que le client a envoyé pour créer un concours.
 * Renvoie un objet prêt à insérer, ou lève une ContestValidationError dont le
 * message est directement affichable.
 *
 * Asynchrone parce que la monnaie est vérifiée en base : accepter un
 * `currency_id` sans le résoudre laisserait créer un concours dont la
 * cagnotte ne pourrait jamais être versée.
 */
async function normalizeCreatePayload(body = {}, authorId = null) {
  const Contest = require('../models/Contest');
  const { VirtualCurrency } = require('../models');

  const amount = roundTWC(Number.parseFloat(body.prize_amount));
  if (!Number.isFinite(amount) || amount < MIN_PRIZE) {
    throw new ContestValidationError(
      `Indique le montant mis en jeu (au moins ${MIN_PRIZE}).`,
      'PRIZE_REQUIRED'
    );
  }

  const currencyId = String(body.currency_id || '').trim();
  if (!currencyId) {
    throw new ContestValidationError('Choisis la monnaie de la cagnotte.', 'CURRENCY_REQUIRED');
  }
  const currency = await VirtualCurrency.findByPk(currencyId);
  if (!currency || !currency.isActive) {
    throw new ContestValidationError(
      "Cette monnaie n'existe pas ou n'est plus active.",
      'CURRENCY_UNKNOWN'
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
  // Sans auteur connu (appel interne), on retombe sur la durée commune : une
  // borne se relève sur preuve de palier, jamais par défaut.
  const maxDurationDays = authorId
    ? await ultraLimit({ id: authorId }, MAX_DURATION_DAYS_ULTRA, MAX_DURATION_DAYS)
    : MAX_DURATION_DAYS;
  if (endsAt.getTime() > now + maxDurationDays * 86_400_000) {
    throw new ContestValidationError(
      `Un concours ne peut pas durer plus de ${maxDurationDays} jours.`,
      'ENDS_AT_TOO_FAR'
    );
  }

  const { seed, commitment } = Contest.newSeed();
  // Ce qui sera réellement prélevé : le gain est PAR gagnant.
  const escrowTotal = roundTWC(amount * winners);

  return {
    title: body.title ? String(body.title).trim().slice(0, 120) : null,
    prize_amount: amount,
    currency_id: currency.id,
    prize_currency: currency.symbol,
    prize_note: body.prize_note ? String(body.prize_note).trim().slice(0, 160) : null,
    winners_count: winners,
    conditions: Contest.normalizeConditions(body.conditions),
    ends_at: endsAt,
    draw_seed: seed,
    seed_commitment: commitment,
    escrow_total: escrowTotal,
    escrow_status: 'held',
  };
}

/**
 * Traduit un refus du grand livre en message affichable.
 *
 * Le solde insuffisant et le blocage anti-fraude sont les deux refus
 * attendus ; les laisser remonter tels quels afficherait « Solde insuffisant »
 * sans dire combien il manque, ou un code de risque incompréhensible.
 */
function explainLedgerError(error, { total, symbol, balance }) {
  const message = String(error?.message || '');
  if (message.includes('Solde insuffisant')) {
    const missing = roundTWC(Math.max(0, total - (balance ?? 0)));
    return new ContestValidationError(
      `Il te manque ${missing} ${symbol} : la cagnotte (${total} ${symbol}) est prélevée dès la création.`,
      'INSUFFICIENT_FUNDS',
      402
    );
  }
  if (error?.name === 'TransactionRiskError' || String(error?.code || '').startsWith('RISK_')) {
    return new ContestValidationError(
      'Ton portefeuille est bloqué par la protection anti-fraude : impossible de mettre une cagnotte en jeu pour le moment.',
      error.code || 'RISK_BLOCKED',
      403
    );
  }
  return null;
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
    const rejected = [];
    for (const entry of entries) {
      const { ok, missing } = await checkConditions(contest, entry.user_id);
      if (ok) {
        eligible.push(entry);
      } else {
        entry.rejected_reason = missing.map((m) => m.label).join(', ').slice(0, 80);
        rejected.push(entry);
      }
    }

    // AUDIT B1-05 : marquer éligible/rejeté n'est qu'un enregistrement de
    // résultat, pas une opération d'argent — écrit en lot, hors de la
    // transaction, pour que sa durée ne dépende plus du nombre de
    // participants (avant : un `save()` par participant, sous le verrou de
    // trésorerie du versement ci-dessous).
    if (eligible.length > 0) {
      await ContestEntry.update(
        { status: 'eligible', rejected_reason: null },
        { where: { id: eligible.map((e) => e.id) } }
      );
    }
    // `rejected_reason` varie par entrée : groupées par valeur distincte,
    // c'est toujours un nombre borné de requêtes, jamais une par participant.
    const byReason = new Map();
    for (const entry of rejected) {
      const ids = byReason.get(entry.rejected_reason) || [];
      ids.push(entry.id);
      byReason.set(entry.rejected_reason, ids);
    }
    for (const [reason, ids] of byReason) {
      await ContestEntry.update(
        { status: 'rejected', rejected_reason: reason },
        { where: { id: ids } }
      );
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
      // Bornée par `contest.winners_count`, contrairement à la boucle sur
      // `entries` d'avant (B1-05) : le verrou de trésorerie pris plus bas par
      // `settleEscrow` n'est plus tenu le temps de tout le concours.
      for (const w of winners) {
        await w.entry.save({ transaction, fields: ['is_winner', 'rank'] });
      }

      // Versement dans la MÊME transaction que la clôture : soit les gagnants
      // sont payés ET le concours est clos, soit rien n'a bougé. Un versement
      // commité sans clôture serait rejoué au passage suivant du cron.
      await settleEscrow(contest, winners.map((w) => w.entry), transaction);

      await contest.update(
        { status: 'closed', drawn_at: new Date() },
        { transaction }
      );
    });

    await notifyResults(contest, entries, winners.map((w) => w.entry), Notification);

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
 * Verse la cagnotte : chaque gagnant est crédité de `prize_amount` depuis la
 * trésorerie, et la part non attribuée revient à l'organisateur.
 *
 * La part non attribuée n'est pas un cas rare : un concours à 3 gagnants qui
 * n'a que 1 participant éligible laisse 2 parts en trésorerie. Sans ce
 * remboursement, l'argent resterait bloqué là indéfiniment, prélevé à
 * quelqu'un pour personne.
 *
 * `escrow_status` est vérifié avant toute écriture ET repositionné dans la
 * même transaction : c'est ce qui rend un double versement impossible.
 */
async function settleEscrow(contest, winners, transaction) {
  if (contest.escrow_status !== 'held' || !contest.currency_id) {
    // Concours hérité (créé avant le séquestre) : rien à verser, le montant
    // n'a jamais été prélevé. Le tirage reste valable, il est juste déclaratif.
    return;
  }

  const share = roundTWC(Number(contest.prize_amount));
  const total = roundTWC(Number(contest.escrow_total));
  let paid = 0;

  for (const winner of winners) {
    await EconomyLedger.rewardFromTreasury(
      winner.user_id,
      contest.currency_id,
      share,
      `Concours gagné - ${share} ${contest.prize_currency}`,
      transaction
    );
    paid = roundTWC(paid + share);
  }

  // `rewardFromTreasury` refuse un crédit sous MIN_PRIZE : une poussière
  // d'arrondi ferait échouer tout le tirage plutôt que de rendre 0,004 NF.
  const leftover = roundTWC(total - paid);
  if (leftover >= MIN_PRIZE) {
    await EconomyLedger.rewardFromTreasury(
      contest.creator_id,
      contest.currency_id,
      leftover,
      winners.length === 0
        ? `Concours sans gagnant - remboursement ${leftover} ${contest.prize_currency}`
        : `Concours - part non attribuee remboursee (${leftover} ${contest.prize_currency})`,
      transaction
    );
  }

  await contest.update(
    { escrow_status: winners.length > 0 ? 'paid' : 'refunded' },
    { transaction }
  );

  // Les métriques de la monnaie bougent avec la circulation : le casino fait
  // le même appel après chaque mouvement.
  await EconomyMetrics.refresh(contest.currency_id, transaction);
}

/**
 * Rend la totalité de la cagnotte à l'organisateur (annulation avant tirage).
 * Renvoie le montant remboursé, 0 s'il n'y avait rien à rendre.
 */
async function refundEscrow(contest, transaction) {
  if (contest.escrow_status !== 'held' || !contest.currency_id) return 0;

  const total = roundTWC(Number(contest.escrow_total));
  if (total > 0) {
    await EconomyLedger.rewardFromTreasury(
      contest.creator_id,
      contest.currency_id,
      total,
      `Concours annule - remboursement ${total} ${contest.prize_currency}`,
      transaction
    );
    await EconomyMetrics.refresh(contest.currency_id, transaction);
  }
  await contest.update({ escrow_status: 'refunded' }, { transaction });
  return total;
}

/**
 * Notifie les gagnants, les participants non tirés et l'organisateur. Le
 * type reste `system` avec un sous-type dans `metadata.kind` : ajouter une
 * valeur à l'ENUM `type` des notifications imposerait une migration à toute
 * la table.
 *
 * `entries` contient TOUS les participants (gagnants inclus) : sans notifier
 * aussi les non-gagnants, seuls les gagnants et l'organisateur apprenaient
 * que le tirage avait eu lieu — les autres participants n'avaient aucun
 * moyen de savoir que leur concours était terminé, ni où revoir le résultat.
 */
async function notifyResults(contest, entries, winners, Notification) {
  const prize = `${roundTWC(Number(contest.prize_amount))} ${contest.prize_currency}`;
  // `paid` = les portefeuilles ont bougé. Sur un concours hérité (sans
  // séquestre), annoncer un crédit qui n'a pas eu lieu serait un mensonge.
  const paidOut = contest.escrow_status === 'paid';
  const winnerIds = new Set(winners.map((w) => w.user_id));
  try {
    for (const winner of winners) {
      await Notification.create({
        recipient_id: winner.user_id,
        sender_id: contest.creator_id,
        tweet_id: contest.tweet_id,
        type: 'system',
        title: 'Tu as gagné le concours',
        message: paidOut
          ? `${prize} viennent d'être crédités sur ton portefeuille.`
          : `Tu fais partie des gagnants du concours (${prize}).`,
        priority: 'high',
        content: { contest_id: contest.id, rank: winner.rank, prize },
        metadata: { kind: 'contest_won', contest_id: contest.id },
      });
    }
    for (const entry of entries) {
      if (winnerIds.has(entry.user_id)) continue;
      await Notification.create({
        recipient_id: entry.user_id,
        sender_id: contest.creator_id,
        tweet_id: contest.tweet_id,
        type: 'system',
        title: 'Le tirage du concours a eu lieu',
        message:
          winners.length > 0
            ? "Tu n'as pas été tiré au sort cette fois. Viens voir qui a gagné."
            : 'Aucun participant ne remplissait les conditions au moment du tirage.',
        priority: 'normal',
        content: { contest_id: contest.id },
        metadata: { kind: 'contest_ended', contest_id: contest.id },
      });
    }
    await Notification.create({
      recipient_id: contest.creator_id,
      tweet_id: contest.tweet_id,
      type: 'system',
      title: 'Ton concours est terminé',
      message: winners.length
        ? paidOut
          ? `${winners.length} gagnant(s) tiré(s) et payé(s) automatiquement.`
          : `${winners.length} gagnant(s) tiré(s).`
        : paidOut || contest.escrow_status === 'refunded'
          ? "Aucun participant éligible : la cagnotte t'a été remboursée."
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
  listUsableCurrencies,
  explainLedgerError,
  checkConditions,
  refundEscrow,
  drawContest,
  drawDueContests,
  MAX_DURATION_DAYS,
  MAX_DURATION_DAYS_ULTRA,
  MIN_DURATION_MINUTES,
  MIN_PRIZE,
};
