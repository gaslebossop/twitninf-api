const { Op } = require('sequelize');
const {
  User,
  UsernameListing,
  UsernameSale,
  UsernameReservation,
  Notification,
} = require('../models');
const { sequelize } = require('../database/index');
const { EconomyLedger, roundTWC, toAmount } = require('../economy');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const {
  PLATFORM_USERNAME_FEE_RATE,
  PLATFORM_USERNAME_FEE_RATE_ULTRA,
  USERNAME_MIN_PRICE_TWC,
  USERNAME_MAX_PRICE_TWC,
  USERNAME_RESERVATION_PRICE_TWC,
  USERNAME_RESERVATION_DAYS,
  USERNAME_RESERVATION_DAYS_ULTRA,
  USERNAME_RESERVATION_MAX_PER_USER,
  USERNAME_RESERVATION_MAX_PER_USER_ULTRA,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');
const { ultraLimit, isUltraRequest } = require('../utils/ultraGate');
const { isUltraActive } = require('../utils/subscriptionHelpers');

/**
 * Marché des noms d'utilisateur : réserver, vendre, acheter.
 *
 * Un pseudo n'est pas un objet de l'inventaire, c'est l'identité publique
 * d'un compte : des liens pointent dessus, des mentions le citent, des gens
 * reconnaissent quelqu'un par lui. Trois règles en découlent, et elles
 * expliquent la plus grosse partie du code ci-dessous.
 *
 * 1. **On ne vend pas un pseudo sans en prendre un autre.** Le pseudo de
 *    remplacement est choisi ET réservé À LA MISE EN VENTE. Le demander au
 *    moment de l'achat obligerait soit à attendre la réponse du vendeur avec
 *    l'acheteur déjà débité, soit à lui coller un identifiant qu'il n'a pas
 *    choisi.
 *
 * 2. **L'échange est atomique.** Débit, deux changements de pseudo, écriture
 *    de la vente : une seule transaction. Un état intermédiaire visible,
 *    c'est deux comptes qui portent le même nom ou un pseudo qui n'appartient
 *    à personne.
 *
 * 3. **Un pseudo libéré n'est pas immédiatement libre.** Il part en
 *    réservation système. Sans ce délai, le premier venu récupère l'identité
 *    d'un compte connu à la seconde où celui-ci en change — et hérite de tous
 *    les liens qui pointaient dessus.
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;
/** Un pseudo libéré reste bloqué ce temps-là avant de retomber sur le marché. */
const FORMER_USERNAME_HOLD_DAYS = 30;

class UsernameMarketError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UsernameMarketError';
    this.code = code;
  }
}

function normalize(username) {
  return String(username || '').trim().toLowerCase();
}

function assertValidUsername(username) {
  const raw = String(username || '').trim();
  if (!USERNAME_PATTERN.test(raw)) {
    throw new UsernameMarketError(
      'Un pseudo fait 3 à 30 caractères, lettres, chiffres et « _ » uniquement.',
      'invalid_username',
    );
  }
  return raw;
}

/**
 * Un pseudo est-il libre ?
 *
 * Deux conditions, pas une : absent de `users` ET sans réservation active.
 * Ne regarder que `users` laisserait acheter un pseudo déjà retenu par
 * quelqu'un — ou le pseudo de remplacement d'un vendeur, ce qui casserait sa
 * vente au pire moment.
 */
async function availability(username, { forUserId = null, transaction = null } = {}) {
  const raw = assertValidUsername(username);
  const lower = normalize(raw);

  const taken = await User.findOne({
    where: sequelize.where(sequelize.fn('lower', sequelize.col('username')), lower),
    attributes: ['id', 'username'],
    transaction,
  });
  if (taken) {
    return {
      username: raw,
      available: false,
      reason: String(taken.id) === String(forUserId) ? 'yours' : 'taken',
    };
  }

  const reserved = await UsernameReservation.findOne({
    where: {
      username: lower,
      claimed_at: null,
      released_at: null,
      expires_at: { [Op.gt]: new Date() },
    },
    transaction,
  });
  if (reserved) {
    const mine = forUserId && String(reserved.user_id) === String(forUserId);
    return {
      username: raw,
      available: Boolean(mine),
      reason: mine ? 'reserved_by_you' : 'reserved',
      expires_at: reserved.expires_at,
    };
  }

  return { username: raw, available: true, reason: null };
}

/** Pose une réservation système (pseudo de repli, pseudo libéré). */
async function reserveSystem({ username, origin, days = FORMER_USERNAME_HOLD_DAYS, userId = null, transaction }) {
  return UsernameReservation.create({
    username: normalize(username),
    user_id: userId,
    kind: 'system',
    origin,
    expires_at: new Date(Date.now() + days * 86400000),
  }, { transaction });
}

/**
 * Réservation payante d'un pseudo libre — avantage abonné.
 *
 * Payante et limitée à cinq par compte : gratuite, elle servirait le jour même
 * à préempter tous les pseudos courts, ce qui tuerait le marché avant qu'il
 * n'existe.
 */
async function reserve({ userId, username }) {
  const raw = assertValidUsername(username);
  const lower = normalize(raw);

  return sequelize.transaction(async (t) => {
    const state = await availability(raw, { forUserId: userId, transaction: t });
    if (!state.available) {
      throw new UsernameMarketError('Ce pseudo n\'est pas disponible.', 'unavailable');
    }

    const active = await UsernameReservation.count({
      where: {
        user_id: userId,
        kind: 'user',
        claimed_at: null,
        released_at: null,
        expires_at: { [Op.gt]: new Date() },
      },
      transaction: t,
    });
    // Le plafond dépend du palier : 20 réservations simultanées pour un
    // Ultra, 5 pour les autres. Relu dans la MÊME transaction que le comptage,
    // sinon deux réservations concurrentes pourraient chacune voir la place
    // que l'autre est en train de prendre.
    // Un seul test de palier pour les deux bornes qui en dependent : combien
    // de pseudos tenus en reserve, et combien de temps chacun.
    const ultra = await isUltraRequest({ id: userId }, t);
    const maxReservations = ultra
      ? USERNAME_RESERVATION_MAX_PER_USER_ULTRA
      : USERNAME_RESERVATION_MAX_PER_USER;
    const reservationDays = ultra
      ? USERNAME_RESERVATION_DAYS_ULTRA
      : USERNAME_RESERVATION_DAYS;
    if (active >= maxReservations) {
      throw new UsernameMarketError(
        `Tu as déjà ${maxReservations} pseudos réservés.`,
        'limit_reached',
      );
    }

    const currency = await getPlatformCurrency({ transaction: t });
    if (!currency) throw new UsernameMarketError('Monnaie indisponible', 'no_currency');

    const spend = await EconomyLedger.spendToTreasury(
      userId,
      currency.id,
      USERNAME_RESERVATION_PRICE_TWC,
      {
        description: `Réservation du pseudo @${raw}`,
        itemType: 'username_reservation',
        itemId: lower,
        spendingCategory: 'identity',
      },
      t,
    );

    return UsernameReservation.create({
      username: lower,
      user_id: userId,
      kind: 'user',
      origin: 'purchase',
      price_twc: USERNAME_RESERVATION_PRICE_TWC,
      spend_transaction_id: spend?.tx?.id || null,
      expires_at: new Date(Date.now() + reservationDays * 86400000),
    }, { transaction: t });
  });
}

/**
 * Prend effectivement un pseudo réservé (ou libre) comme identité.
 *
 * L'ancien pseudo part en réservation système : voir la règle 3 en tête de
 * fichier.
 */
async function claim({ userId, username }) {
  const raw = assertValidUsername(username);
  const lower = normalize(raw);

  return sequelize.transaction(async (t) => {
    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.NO_KEY_UPDATE });
    if (!user) throw new UsernameMarketError('Utilisateur introuvable', 'not_found');
    if (normalize(user.username) === lower) {
      throw new UsernameMarketError('C\'est déjà ton pseudo.', 'already_yours');
    }

    const state = await availability(raw, { forUserId: userId, transaction: t });
    if (!state.available) {
      throw new UsernameMarketError('Ce pseudo n\'est pas disponible.', 'unavailable');
    }

    // Une annonce en cours porte sur le pseudo actuel : le changer par ce
    // chemin la viderait de son objet sans prévenir l'acheteur potentiel.
    const listed = await UsernameListing.findOne({
      where: { seller_id: userId, status: 'active' },
      transaction: t,
    });
    if (listed) {
      throw new UsernameMarketError(
        'Annule d\'abord la vente de ton pseudo actuel.',
        'listing_active',
      );
    }

    const previous = user.username;
    await user.update({ username: raw }, { transaction: t });

    await UsernameReservation.update(
      { claimed_at: new Date() },
      { where: { username: lower, user_id: userId, claimed_at: null }, transaction: t },
    );
    await reserveSystem({ username: previous, origin: 'former_username', transaction: t });

    return { previous, username: raw };
  });
}

// ── Annonces ───────────────────────────────────────────────────────────────

async function createListing({ sellerId, priceTwc, replacementUsername }) {
  const price = roundTWC(priceTwc);
  if (!Number.isFinite(price) || price < USERNAME_MIN_PRICE_TWC) {
    throw new UsernameMarketError(`Prix minimum : ${USERNAME_MIN_PRICE_TWC} NF`, 'price_too_low');
  }
  if (price > USERNAME_MAX_PRICE_TWC) {
    throw new UsernameMarketError(`Prix maximum : ${USERNAME_MAX_PRICE_TWC} NF`, 'price_too_high');
  }
  const replacement = assertValidUsername(replacementUsername);

  return sequelize.transaction(async (t) => {
    const seller = await User.findByPk(sellerId, { transaction: t, lock: t.LOCK.NO_KEY_UPDATE });
    if (!seller) throw new UsernameMarketError('Utilisateur introuvable', 'not_found');

    if (normalize(replacement) === normalize(seller.username)) {
      throw new UsernameMarketError(
        'Ton pseudo de remplacement doit être différent de celui que tu vends.',
        'same_username',
      );
    }

    const existing = await UsernameListing.findOne({
      where: { seller_id: sellerId, status: 'active' },
      transaction: t,
    });
    if (existing) {
      throw new UsernameMarketError('Ton pseudo est déjà en vente.', 'already_listed');
    }

    const state = await availability(replacement, { forUserId: sellerId, transaction: t });
    if (!state.available) {
      throw new UsernameMarketError(
        'Ton pseudo de remplacement n\'est pas disponible.',
        'replacement_unavailable',
      );
    }

    const currency = await getPlatformCurrency({ transaction: t });
    if (!currency) throw new UsernameMarketError('Monnaie indisponible', 'no_currency');

    // Le remplacement est verrouillé pendant toute la durée de l'annonce :
    // sans ça, quelqu'un peut le prendre entre-temps et l'échange casse une
    // fois l'acheteur débité.
    await reserveSystem({
      username: replacement,
      origin: 'listing_replacement',
      userId: sellerId,
      days: 365,
      transaction: t,
    });

    return UsernameListing.create({
      seller_id: sellerId,
      username: normalize(seller.username),
      replacement_username: replacement,
      currency_id: currency.id,
      price_twc: price,
    }, { transaction: t });
  });
}

async function cancelListing({ sellerId, listingId }) {
  return sequelize.transaction(async (t) => {
    const listing = await UsernameListing.findByPk(listingId, { transaction: t });
    if (!listing) throw new UsernameMarketError('Annonce introuvable', 'not_found');
    if (String(listing.seller_id) !== String(sellerId)) {
      throw new UsernameMarketError('Cette annonce n\'est pas la tienne', 'forbidden');
    }
    if (listing.status !== 'active') {
      throw new UsernameMarketError('Cette annonce n\'est plus active', 'not_active');
    }

    await listing.update({ status: 'canceled' }, { transaction: t });
    // Le remplacement retenu pour cette annonce est rendu au marché.
    await UsernameReservation.update(
      { released_at: new Date() },
      {
        where: {
          username: normalize(listing.replacement_username),
          origin: 'listing_replacement',
          user_id: sellerId,
          released_at: null,
          claimed_at: null,
        },
        transaction: t,
      },
    );
    return listing;
  });
}

/**
 * Achat d'un pseudo : l'échange proprement dit.
 *
 * Ordre des écritures, et il n'est pas interchangeable :
 *   1. le vendeur prend son pseudo de remplacement (ce qui LIBÈRE le pseudo vendu) ;
 *   2. l'acheteur prend le pseudo vendu (ce qui libère le sien) ;
 *   3. l'ancien pseudo de l'acheteur part en réservation système.
 * Inverser 1 et 2 ferait échouer l'étape 2 sur la contrainte d'unicité.
 */
async function buyListing({ buyerId, listingId }) {
  const result = await sequelize.transaction(async (t) => {
    const listing = await UsernameListing.findByPk(listingId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!listing) throw new UsernameMarketError('Annonce introuvable', 'not_found');
    if (listing.status !== 'active') {
      throw new UsernameMarketError('Ce pseudo n\'est plus en vente.', 'not_active');
    }
    if (String(listing.seller_id) === String(buyerId)) {
      throw new UsernameMarketError('C\'est ton propre pseudo.', 'own_listing');
    }

    // Les deux comptes sont verrouillés dans un ordre déterministe (par id) :
    // deux achats croisés simultanés se bloqueraient sinon mutuellement.
    //
    // `NO KEY UPDATE` et pas `UPDATE`, sinon l'achat se bloquait LUI-MÊME :
    // plus bas, le grand livre demande une autorisation anti-fraude qui
    // insère une ligne référençant ces mêmes comptes — sur une AUTRE
    // connexion, hors de cette transaction. Cette insertion prend un verrou
    // `FOR KEY SHARE` sur `users`, incompatible avec `FOR UPDATE` : elle
    // attendait la fin d'une transaction qui, elle, attendait l'insertion.
    // La requête mourait sur le délai de 3 s de Sequelize, et l'app voyait
    // « Achat impossible ».
    //
    // `NO KEY UPDATE` empêche toujours deux achats simultanés de se marcher
    // dessus ; il n'entre en conflit qu'avec les verrous de clé, et on ne
    // touche ici qu'à `username`, qu'aucune clé étrangère ne référence.
    const ids = [String(listing.seller_id), String(buyerId)].sort();
    const locked = await User.findAll({
      where: { id: { [Op.in]: ids } },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.NO_KEY_UPDATE,
    });
    const seller = locked.find((u) => String(u.id) === String(listing.seller_id));
    const buyer = locked.find((u) => String(u.id) === String(buyerId));
    if (!seller || !buyer) throw new UsernameMarketError('Compte introuvable', 'not_found');

    // Le vendeur a pu changer de pseudo par un autre chemin depuis la mise en
    // vente : l'annonce ne porte alors plus sur rien.
    if (normalize(seller.username) !== normalize(listing.username)) {
      await listing.update({
        status: 'invalid',
        invalidated_reason: 'Le vendeur ne porte plus ce pseudo',
      }, { transaction: t });
      throw new UsernameMarketError('Ce pseudo n\'est plus disponible.', 'seller_changed');
    }

    const price = toAmount(listing.price_twc);
    // La commission est prélevée sur ce que touche le VENDEUR : c'est donc son
    // palier à lui qui la fixe, pas celui de l'acheteur. `seller` est déjà
    // verrouillé et chargé en entier ci-dessus — pas de requête de plus.
    const feeRate = isUltraActive(seller)
      ? PLATFORM_USERNAME_FEE_RATE_ULTRA
      : PLATFORM_USERNAME_FEE_RATE;
    const fee = roundTWC(price * feeRate);
    const net = roundTWC(price - fee);

    const spend = await EconomyLedger.spendToTreasury(
      buyerId,
      listing.currency_id,
      price,
      {
        description: `Achat du pseudo @${listing.username}`,
        itemType: 'username_purchase',
        itemId: listing.id,
        spendingCategory: 'identity',
        metadata: { sellerId: listing.seller_id, username: listing.username },
      },
      t,
    );

    let payoutTxId = null;
    if (net > 0) {
      const payout = await EconomyLedger.rewardFromTreasury(
        listing.seller_id,
        listing.currency_id,
        net,
        `Vente du pseudo @${listing.username}`,
        t,
      );
      if (payout && payout.success) payoutTxId = payout.tx?.id || null;
    }

    const soldUsername = seller.username;
    const buyerPrevious = buyer.username;

    // 1. le vendeur libère le pseudo vendu
    await seller.update({ username: listing.replacement_username }, { transaction: t });
    // 2. l'acheteur le prend
    await buyer.update({ username: soldUsername }, { transaction: t });

    // La réservation qui protégeait le remplacement est consommée.
    await UsernameReservation.update(
      { claimed_at: new Date() },
      {
        where: {
          username: normalize(listing.replacement_username),
          origin: 'listing_replacement',
          claimed_at: null,
        },
        transaction: t,
      },
    );
    // 3. l'ancien pseudo de l'acheteur est mis au frais.
    await reserveSystem({ username: buyerPrevious, origin: 'former_username', transaction: t });

    await listing.update({
      status: 'sold',
      sold_at: new Date(),
      buyer_id: buyerId,
    }, { transaction: t });

    const sale = await UsernameSale.create({
      listing_id: listing.id,
      username: normalize(soldUsername),
      seller_id: listing.seller_id,
      buyer_id: buyerId,
      buyer_previous_username: buyerPrevious,
      seller_new_username: listing.replacement_username,
      currency_id: listing.currency_id,
      price_twc: price,
      platform_fee_twc: fee,
      seller_net_twc: net,
      platform_fee_rate: feeRate,
      spend_transaction_id: spend?.tx?.id || null,
      payout_transaction_id: payoutTxId,
    }, { transaction: t });

    return { sale, listing, price, fee, net, soldUsername, buyerPrevious };
  });

  // Les deux comptes changent d'identité publique : les prévenir n'est pas
  // du confort. Le vendeur découvrirait sinon son nouveau pseudo par hasard.
  try {
    await Notification.createNotification({
      recipient_id: result.listing.seller_id,
      sender_id: buyerId,
      type: 'premium',
      title: 'Ton pseudo a été vendu',
      message: `@${result.soldUsername} est parti pour ${result.price} NF. Tu es maintenant @${result.listing.replacement_username} (+${result.net} NF).`,
      priority: 'high',
      content: {
        kind: 'username_sold',
        sale_id: result.sale.id,
        username: result.soldUsername,
        new_username: result.listing.replacement_username,
        net_twc: result.net,
      },
    });
    await Notification.createNotification({
      recipient_id: buyerId,
      type: 'premium',
      title: 'Nouveau pseudo',
      message: `Tu es maintenant @${result.soldUsername}. Ton ancien pseudo @${result.buyerPrevious} reste protégé ${FORMER_USERNAME_HOLD_DAYS} jours.`,
      priority: 'high',
      content: {
        kind: 'username_bought',
        sale_id: result.sale.id,
        username: result.soldUsername,
        previous_username: result.buyerPrevious,
      },
    });
  } catch (e) {
    logger.warn('[usernameMarket] Notifications de vente non envoyées:', e.message);
  }

  return result;
}

// ── Consultation ───────────────────────────────────────────────────────────

function listingPayload(listing) {
  return {
    id: listing.id,
    username: listing.username,
    price_twc: toAmount(listing.price_twc),
    status: listing.status,
    created_at: listing.created_at,
    views_count: listing.views_count,
    seller: listing.seller
      ? {
        id: listing.seller.id,
        username: listing.seller.username,
        full_name: listing.seller.full_name,
        avatar: listing.seller.avatar,
        verified: listing.seller.verified,
      }
      : null,
  };
}

async function browse({ search, minPrice, maxPrice, sort = 'recent', limit = 40, offset = 0 } = {}) {
  const where = { status: 'active' };
  if (search) where.username = { [Op.iLike]: `%${normalize(search)}%` };
  if (minPrice != null || maxPrice != null) {
    where.price_twc = {};
    if (minPrice != null) where.price_twc[Op.gte] = roundTWC(minPrice);
    if (maxPrice != null) where.price_twc[Op.lte] = roundTWC(maxPrice);
  }

  const order = sort === 'price_asc' ? [['price_twc', 'ASC']]
    : sort === 'price_desc' ? [['price_twc', 'DESC']]
      : sort === 'short' ? [[sequelize.fn('length', sequelize.col('username')), 'ASC']]
        : [['created_at', 'DESC']];

  const rows = await UsernameListing.findAll({
    where,
    include: [{ model: User, as: 'seller', attributes: ['id', 'username', 'full_name', 'avatar', 'verified'] }],
    order,
    limit: Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
  });

  return rows.map(listingPayload);
}

async function myMarket(userId) {
  const [listings, reservations, purchases, sales] = await Promise.all([
    UsernameListing.findAll({
      where: { seller_id: userId },
      order: [['created_at', 'DESC']],
      limit: 20,
    }),
    UsernameReservation.findAll({
      where: {
        user_id: userId,
        kind: 'user',
        claimed_at: null,
        released_at: null,
        expires_at: { [Op.gt]: new Date() },
      },
      order: [['expires_at', 'ASC']],
    }),
    UsernameSale.findAll({ where: { buyer_id: userId }, order: [['created_at', 'DESC']], limit: 20 }),
    UsernameSale.findAll({ where: { seller_id: userId }, order: [['created_at', 'DESC']], limit: 20 }),
  ]);

  // Ces trois valeurs sont ce que l'écran AFFICHE ; elles doivent donc être
  // celles que l'écriture appliquera, pas les valeurs communes.
  const ultra = await isUltraRequest({ id: userId });

  return {
    fee_rate: ultra ? PLATFORM_USERNAME_FEE_RATE_ULTRA : PLATFORM_USERNAME_FEE_RATE,
    reservation_price_twc: USERNAME_RESERVATION_PRICE_TWC,
    reservation_days: ultra ? USERNAME_RESERVATION_DAYS_ULTRA : USERNAME_RESERVATION_DAYS,
    listings: listings.map((l) => ({
      id: l.id,
      username: l.username,
      replacement_username: l.replacement_username,
      price_twc: toAmount(l.price_twc),
      status: l.status,
      created_at: l.created_at,
      sold_at: l.sold_at,
    })),
    reservations: reservations.map((r) => ({
      id: r.id,
      username: r.username,
      expires_at: r.expires_at,
    })),
    purchases: purchases.map((s) => ({
      id: s.id,
      username: s.username,
      price_twc: toAmount(s.price_twc),
      created_at: s.created_at,
    })),
    sales: sales.map((s) => ({
      id: s.id,
      username: s.username,
      price_twc: toAmount(s.price_twc),
      net_twc: toAmount(s.seller_net_twc),
      created_at: s.created_at,
    })),
  };
}

/** Historique public d'un pseudo — la question que pose toute arnaque. */
async function historyOf(username) {
  const lower = normalize(username);
  const sales = await UsernameSale.findAll({
    where: { username: lower },
    order: [['created_at', 'ASC']],
    attributes: ['id', 'price_twc', 'created_at'],
  });
  return sales.map((s) => ({
    sold_at: s.created_at,
    price_twc: toAmount(s.price_twc),
  }));
}

/** Libère les réservations expirées. Appelée par le planificateur. */
async function releaseExpired() {
  const [count] = await UsernameReservation.update(
    { released_at: new Date() },
    {
      where: {
        claimed_at: null,
        released_at: null,
        expires_at: { [Op.lte]: new Date() },
      },
    },
  );
  if (count) logger.info(`[usernameMarket] ${count} réservation(s) expirée(s) libérée(s)`);
  return count;
}

module.exports = {
  UsernameMarketError,
  availability,
  reserve,
  claim,
  createListing,
  cancelListing,
  buyListing,
  browse,
  myMarket,
  historyOf,
  releaseExpired,
  normalize,
  PLATFORM_USERNAME_FEE_RATE,
};
