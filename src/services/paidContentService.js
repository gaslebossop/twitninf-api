const { Op } = require('sequelize');
const {
  PaidContent,
  ContentPurchase,
  Tweet,
  Story,
  User,
  Notification,
} = require('../models');
const { sequelize } = require('../database/index');
const { EconomyLedger, roundTWC, toAmount } = require('../economy');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const {
  PLATFORM_CONTENT_FEE_RATE,
  PAID_CONTENT_MIN_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC,
  PAID_CONTENT_PREVIEW_CHARS,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * Contenu payant à l'unité.
 *
 * Deux règles portent tout le reste :
 *
 * 1. **Le masquage est fait au serveur.** Renvoyer le texte complet en
 *    laissant l'app poser un flou par-dessus reviendrait à ne rien vendre :
 *    la réponse HTTP contient alors la marchandise. Ce qui n'est pas acheté
 *    ne quitte jamais la machine.
 * 2. **Les montants sont calculés ici.** Le client envoie un prix à la mise
 *    en vente, jamais à l'achat, et la commission n'est jamais lue depuis la
 *    requête.
 */

/** Un contenu verrouillé se résume à ça pour l'app tant qu'il n'est pas acheté. */
function publicLockPayload(lock, { hasAccess, isCreator }) {
  return {
    id: lock.id,
    content_type: lock.content_type,
    content_id: lock.content_id,
    creator_id: lock.creator_id,
    price_twc: toAmount(lock.price_twc),
    preview_text: lock.preview_text || null,
    is_active: lock.is_active,
    has_access: hasAccess,
    is_creator: isCreator,
    // Ces deux compteurs n'intéressent que le vendeur, et ne sont joints
    // qu'à lui : le nombre d'acheteurs d'un contenu est une donnée
    // commerciale, pas un élément d'affichage public.
    purchases_count: isCreator ? lock.purchases_count : undefined,
    net_twc: isCreator ? toAmount(lock.net_twc) : undefined,
  };
}

function buildPreview(lock, rawContent) {
  if (lock.preview_text) return lock.preview_text;
  const text = String(rawContent || '').trim();
  if (!text) return null;
  if (text.length <= PAID_CONTENT_PREVIEW_CHARS) return text;
  return `${text.slice(0, PAID_CONTENT_PREVIEW_CHARS).trimEnd()}…`;
}

function normalizePrice(raw) {
  const price = roundTWC(raw);
  if (!Number.isFinite(price) || price < PAID_CONTENT_MIN_PRICE_TWC) {
    throw new Error(`Prix minimum : ${PAID_CONTENT_MIN_PRICE_TWC} NF`);
  }
  if (price > PAID_CONTENT_MAX_PRICE_TWC) {
    throw new Error(`Prix maximum : ${PAID_CONTENT_MAX_PRICE_TWC} NF`);
  }
  return price;
}

/**
 * Vérifie que le contenu existe ET appartient bien au créateur.
 *
 * Sans ce contrôle, n'importe quel compte Pro pourrait poser un verrou sur le
 * tweet d'un autre et encaisser les ventes d'un contenu qu'il n'a pas écrit.
 */
async function assertOwnership(contentType, contentId, creatorId) {
  if (contentType === 'tweet' || contentType === 'live_replay') {
    // `Tweet` est paranoid : un tweet supprimé ne remonte pas, inutile de
    // filtrer `deleted_at` à la main.
    const tweet = await Tweet.findByPk(contentId, {
      attributes: ['id', 'user_id', 'content'],
    });
    if (!tweet) throw new Error('Contenu introuvable');
    if (String(tweet.user_id) !== String(creatorId)) {
      throw new Error('Ce contenu ne t\'appartient pas');
    }
    return { raw: tweet.content };
  }

  const story = await Story.findByPk(contentId, {
    attributes: ['id', 'user_id', 'caption'],
  });
  if (!story) throw new Error('Contenu introuvable');
  if (String(story.user_id) !== String(creatorId)) {
    throw new Error('Ce contenu ne t\'appartient pas');
  }
  return { raw: story.caption };
}

/** Pose (ou remet à jour) un verrou payant. Réservé au palier Pro par la route. */
async function lockContent({ creatorId, contentType, contentId, priceTwc, previewText }) {
  const price = normalizePrice(priceTwc);
  await assertOwnership(contentType, contentId, creatorId);

  const currency = await getPlatformCurrency();
  if (!currency) throw new Error('Monnaie indisponible');

  const existing = await PaidContent.findOne({
    where: { content_type: contentType, content_id: contentId },
  });

  if (existing) {
    if (String(existing.creator_id) !== String(creatorId)) {
      throw new Error('Ce contenu ne t\'appartient pas');
    }
    // Le prix peut changer pour les PROCHAINS acheteurs uniquement : les
    // achats déjà encaissés portent leur propre montant.
    await existing.update({
      price_twc: price,
      preview_text: previewText || existing.preview_text,
      is_active: true,
      unlocked_at: null,
      platform_fee_rate: PLATFORM_CONTENT_FEE_RATE,
    });
    return existing;
  }

  return PaidContent.create({
    creator_id: creatorId,
    content_type: contentType,
    content_id: contentId,
    currency_id: currency.id,
    price_twc: price,
    preview_text: previewText || null,
    platform_fee_rate: PLATFORM_CONTENT_FEE_RATE,
  });
}

/**
 * Retire le verrou : le contenu redevient gratuit pour tout le monde.
 *
 * La ligne est conservée (`is_active = false`) et pas supprimée — elle porte
 * les achats déjà faits. Les acheteurs ne sont pas remboursés : ils ont eu
 * l'accès qu'ils ont payé, et le fait que d'autres l'obtiennent gratuitement
 * ensuite est une décision du créateur, pas un défaut de livraison.
 */
async function unlockContent({ creatorId, paidContentId }) {
  const lock = await PaidContent.findByPk(paidContentId);
  if (!lock) throw new Error('Verrou introuvable');
  if (String(lock.creator_id) !== String(creatorId)) {
    throw new Error('Ce contenu ne t\'appartient pas');
  }
  await lock.update({ is_active: false, unlocked_at: new Date() });
  return lock;
}

/**
 * Achat.
 *
 * Tout est dans une seule transaction SQL : débit, reversement, titre
 * d'accès. Un reversement qui échouerait après le débit laisserait sinon
 * l'acheteur débité et le créateur non payé — le pire des trois états
 * possibles, et celui qu'on ne peut pas rattraper automatiquement.
 */
async function purchase({ buyerId, paidContentId }) {
  return sequelize.transaction(async (t) => {
    const lock = await PaidContent.findByPk(paidContentId, { transaction: t });
    if (!lock) throw new Error('Contenu introuvable');
    if (!lock.is_active) throw new Error('Ce contenu n\'est plus payant');
    if (String(lock.creator_id) === String(buyerId)) {
      throw new Error('Tu es l\'auteur de ce contenu');
    }

    const already = await ContentPurchase.findOne({
      where: { paid_content_id: lock.id, buyer_id: buyerId },
      transaction: t,
    });
    if (already) throw new Error('Tu possèdes déjà ce contenu');

    const price = toAmount(lock.price_twc);
    const rate = toAmount(lock.platform_fee_rate) || PLATFORM_CONTENT_FEE_RATE;
    const fee = roundTWC(price * rate);
    // Le net est le RESTE, pas un second arrondi du produit : sinon fee + net
    // ne retombe pas exactement sur le prix payé, et le grand livre décrit un
    // achat qui n'a pas eu lieu.
    const net = roundTWC(price - fee);

    const spend = await EconomyLedger.spendToTreasury(
      buyerId,
      lock.currency_id,
      price,
      {
        description: 'Achat de contenu',
        itemType: 'paid_content',
        itemId: lock.id,
        spendingCategory: 'content',
        metadata: { creatorId: lock.creator_id, contentType: lock.content_type },
      },
      t,
    );

    let payoutTxId = null;
    if (net > 0) {
      const payout = await EconomyLedger.rewardFromTreasury(
        lock.creator_id,
        lock.currency_id,
        net,
        'Vente de contenu',
        t,
      );
      if (payout && payout.success) payoutTxId = payout.tx?.id || null;
    }

    const record = await ContentPurchase.create({
      paid_content_id: lock.id,
      buyer_id: buyerId,
      creator_id: lock.creator_id,
      currency_id: lock.currency_id,
      price_twc: price,
      platform_fee_twc: fee,
      creator_net_twc: net,
      platform_fee_rate: rate,
      spend_transaction_id: spend?.tx?.id || null,
      payout_transaction_id: payoutTxId,
    }, { transaction: t });

    await lock.update({
      purchases_count: lock.purchases_count + 1,
      gross_twc: roundTWC(toAmount(lock.gross_twc) + price),
      net_twc: roundTWC(toAmount(lock.net_twc) + net),
    }, { transaction: t });

    return { purchase: record, lock, price, fee, net };
  }).then(async (result) => {
    // La notification est hors transaction : elle n'a pas à pouvoir annuler
    // une vente déjà encaissée.
    try {
      const buyer = await User.findByPk(buyerId, { attributes: ['username'] });
      await Notification.createNotification({
        recipient_id: result.lock.creator_id,
        sender_id: buyerId,
        type: 'premium',
        title: 'Vente de contenu',
        message: `@${buyer?.username || 'Quelqu\'un'} a débloqué ton contenu (+${result.net} NF)`,
        content: {
          kind: 'paid_content_sale',
          paid_content_id: result.lock.id,
          content_type: result.lock.content_type,
          content_id: result.lock.content_id,
          net_twc: result.net,
        },
      });
    } catch (e) {
      logger.warn('[paidContent] Notification de vente non envoyée:', e.message);
    }
    return result;
  });
}

/**
 * Rembourse un achat — contenu supprimé, retiré par la modération, litige.
 *
 * Le remboursement reprend au créateur ce qu'il a touché avant de rendre le
 * prix plein à l'acheteur : rembourser depuis la seule trésorerie
 * reviendrait à ce que la plateforme paie le contenu à la place du vendeur.
 */
async function refundPurchase({ purchaseId, reason }) {
  return sequelize.transaction(async (t) => {
    const record = await ContentPurchase.findByPk(purchaseId, { transaction: t });
    if (!record) throw new Error('Achat introuvable');
    if (record.refunded_at) throw new Error('Achat déjà remboursé');

    const price = toAmount(record.price_twc);
    const net = toAmount(record.creator_net_twc);

    if (net > 0) {
      await EconomyLedger.spendToTreasury(
        record.creator_id,
        record.currency_id,
        net,
        {
          description: 'Remboursement d\'une vente de contenu',
          itemType: 'paid_content_refund',
          itemId: record.id,
          spendingCategory: 'refund',
        },
        t,
      );
    }

    const back = await EconomyLedger.rewardFromTreasury(
      record.buyer_id,
      record.currency_id,
      price,
      'Remboursement de contenu',
      t,
    );

    await record.update({
      refunded_at: new Date(),
      refund_reason: (reason || 'Contenu indisponible').slice(0, 160),
      refund_transaction_id: back?.tx?.id || null,
    }, { transaction: t });

    return record;
  });
}

/**
 * Verrous et droits d'accès pour une liste de contenus, en deux requêtes.
 *
 * Appelé sur chaque page de fil : une requête par tweet mettrait le fil à
 * genoux dès qu'un créateur populaire verrouille quelques publications.
 */
async function accessMapFor({ viewerId, contentType, contentIds }) {
  const ids = [...new Set((contentIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const locks = await PaidContent.findAll({
    where: { content_type: contentType, content_id: { [Op.in]: ids }, is_active: true },
  });
  if (!locks.length) return new Map();

  let owned = new Set();
  if (viewerId) {
    const purchases = await ContentPurchase.findAll({
      where: {
        paid_content_id: { [Op.in]: locks.map((l) => l.id) },
        buyer_id: viewerId,
        refunded_at: null,
      },
      attributes: ['paid_content_id'],
    });
    owned = new Set(purchases.map((p) => String(p.paid_content_id)));
  }

  const map = new Map();
  for (const lock of locks) {
    const isCreator = viewerId && String(lock.creator_id) === String(viewerId);
    map.set(String(lock.content_id), {
      lock,
      hasAccess: Boolean(isCreator || owned.has(String(lock.id))),
      isCreator: Boolean(isCreator),
    });
  }
  return map;
}

/**
 * Masque le contenu verrouillé d'une liste de tweets déjà sérialisés.
 *
 * Travaille sur les objets rendus par les routes (et non sur les instances
 * Sequelize) parce que c'est la dernière étape avant `res.json` : c'est le
 * seul endroit où l'on est certain de ne rien laisser passer, quel que soit
 * le moteur de recommandation qui a construit la liste en amont.
 */
async function maskTweets(tweets, viewerId) {
  if (!Array.isArray(tweets) || !tweets.length) return tweets;

  const realTweets = tweets.filter((tw) => tw && !tw.is_ad && tw.id);
  const map = await accessMapFor({
    viewerId,
    contentType: 'tweet',
    contentIds: realTweets.map((tw) => tw.id),
  });
  if (!map.size) return tweets;

  for (const tweet of realTweets) {
    const entry = map.get(String(tweet.id));
    if (!entry) continue;

    const { lock, hasAccess, isCreator } = entry;
    tweet.paid_content = publicLockPayload(lock, { hasAccess, isCreator });

    if (hasAccess) continue;

    // Le texte ET les médias partent : une image reste lisible même sans
    // légende, et c'est souvent elle qu'on vend.
    tweet.content = buildPreview(lock, tweet.content);
    tweet.is_locked = true;
    tweet.media = [];
    tweet.media_urls = JSON.stringify([]);
    if (tweet.translated_content) tweet.translated_content = null;
  }

  return tweets;
}

/** Même masquage pour un tweet seul (route de détail). */
async function maskTweet(tweet, viewerId) {
  if (!tweet) return tweet;
  const [masked] = await maskTweets([tweet], viewerId);
  return masked;
}

/** Un utilisateur a-t-il accès à ce contenu ? Utilisé avant de servir un média. */
async function hasAccess({ viewerId, contentType, contentId }) {
  const map = await accessMapFor({ viewerId, contentType, contentIds: [contentId] });
  const entry = map.get(String(contentId));
  if (!entry) return true; // pas de verrou = contenu libre
  return entry.hasAccess;
}

/** Tableau de bord du vendeur. */
async function creatorDashboard(creatorId, { limit = 50 } = {}) {
  const locks = await PaidContent.findAll({
    where: { creator_id: creatorId },
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
  });

  const totals = locks.reduce((acc, l) => {
    acc.gross = roundTWC(acc.gross + toAmount(l.gross_twc));
    acc.net = roundTWC(acc.net + toAmount(l.net_twc));
    acc.sales += l.purchases_count;
    return acc;
  }, { gross: 0, net: 0, sales: 0 });

  return {
    fee_rate: PLATFORM_CONTENT_FEE_RATE,
    totals: { ...totals, platform_fee: roundTWC(totals.gross - totals.net) },
    items: locks.map((l) => ({
      id: l.id,
      content_type: l.content_type,
      content_id: l.content_id,
      price_twc: toAmount(l.price_twc),
      preview_text: l.preview_text,
      is_active: l.is_active,
      purchases_count: l.purchases_count,
      gross_twc: toAmount(l.gross_twc),
      net_twc: toAmount(l.net_twc),
      created_at: l.created_at,
    })),
  };
}

/** Bibliothèque de l'acheteur. */
async function purchaseHistory(buyerId, { limit = 50 } = {}) {
  const rows = await ContentPurchase.findAll({
    where: { buyer_id: buyerId },
    include: [
      { model: PaidContent, as: 'paidContent' },
      { model: User, as: 'creator', attributes: ['id', 'username', 'full_name', 'avatar', 'verified'] },
    ],
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
  });

  return rows.map((r) => ({
    id: r.id,
    content_type: r.paidContent?.content_type || null,
    content_id: r.paidContent?.content_id || null,
    price_twc: toAmount(r.price_twc),
    refunded: Boolean(r.refunded_at),
    created_at: r.created_at,
    creator: r.creator
      ? {
        id: r.creator.id,
        username: r.creator.username,
        full_name: r.creator.full_name,
        avatar: r.creator.avatar,
        verified: r.creator.verified,
      }
      : null,
  }));
}

module.exports = {
  lockContent,
  unlockContent,
  purchase,
  refundPurchase,
  accessMapFor,
  maskTweets,
  maskTweet,
  hasAccess,
  creatorDashboard,
  purchaseHistory,
  publicLockPayload,
  PLATFORM_CONTENT_FEE_RATE,
};
