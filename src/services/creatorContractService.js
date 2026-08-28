'use strict';

/**
 * Marketplace de contrats sponsorisés — réservée aux créateurs Ultra côté
 * destinataire. N'importe quel compte peut proposer (côté "marque").
 *
 * Argent : aucun mécanisme d'escrow dédié. Réutilise le trésor NF existant
 * (`NewEconomyService`) — le débit de la marque à l'acceptation ET le crédit
 * au créateur (ou le remboursement à la marque) à la résolution passent tous
 * les deux par le trésor, exactement comme `handleUltraPurchase`. Même verrou
 * `NO KEY UPDATE` que le reste des achats NF (voir [[verrou-users-vs-antifraude]]).
 *
 * Cycle de vie (voir `CreatorContract.js` pour le détail de chaque statut) :
 *   pending -> accepted -> draft_submitted -> [changes_requested <-> draft_submitted]* -> approved
 *                       \-> rejected                          draft_submitted -> cancelled
 */

const { Op } = require('sequelize');
const {
  sequelize, User, Tweet, CreatorContract, Notification,
} = require('../models');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const NewEconomyService = require('./newEconomyService');
const transactionAuthorizationService = require('./transactionAuthorizationService');
const logger = require('../utils/logger');

class ContractError extends Error {
  constructor(message, httpStatus = 400, code = 'CONTRACT_ERROR') {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function isRiskError(err) {
  return transactionAuthorizationService.constructor.isRiskError
    ? transactionAuthorizationService.constructor.isRiskError(err)
    : false;
}

async function notify(userId, title, message, kind, extra = {}) {
  try {
    await Notification.create({
      user_id: userId,
      type: 'system',
      title,
      message,
      content: { kind, ...extra },
    });
  } catch (e) {
    logger.error('[creatorContract] notification échouée:', e.message);
  }
}

/** Liste des créateurs Ultra, avec recherche pseudo/bio et fourchette de prix indicatif (purement informatif). */
async function getMarketplace({ search, minPrice, maxPrice, limit = 30, offset = 0 } = {}) {
  const where = { subscription_tier: 'ultra' };

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [
      { username: { [Op.iLike]: term } },
      { full_name: { [Op.iLike]: term } },
      { bio: { [Op.iLike]: term } },
    ];
  }
  if (minPrice != null || maxPrice != null) {
    where.ultra_indicative_price_nf = {};
    if (minPrice != null) where.ultra_indicative_price_nf[Op.gte] = minPrice;
    if (maxPrice != null) where.ultra_indicative_price_nf[Op.lte] = maxPrice;
  }

  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: [
      'id', 'username', 'full_name', 'avatar', 'bio', 'verified',
      'verification_style', 'ultra_indicative_price_nf',
    ],
    order: [['username', 'ASC']],
    limit: Math.min(Number(limit) || 30, 100),
    offset: Math.max(Number(offset) || 0, 0),
  });

  return { creators: rows, total: count };
}

async function setIndicativePrice(userId, priceNf) {
  const user = await User.findByPk(userId);
  if (!user) throw new ContractError('Utilisateur non trouvé', 404, 'USER_NOT_FOUND');
  if (user.subscription_tier !== 'ultra') {
    throw new ContractError('Le prix indicatif est réservé aux comptes Ultra.', 403, 'ULTRA_REQUIRED');
  }
  const value = priceNf == null ? null : Number(priceNf);
  if (value != null && (!Number.isFinite(value) || value < 0)) {
    throw new ContractError('Prix invalide', 400, 'INVALID_PRICE');
  }
  user.ultra_indicative_price_nf = value;
  await user.save();
  return user.ultra_indicative_price_nf;
}

/** La marque propose un contrat à un créateur Ultra. Aucun argent ne bouge encore. */
async function proposeContract({ brandUserId, creatorUserId, priceNf, brief }) {
  if (brandUserId === creatorUserId) {
    throw new ContractError('Impossible de se proposer un contrat à soi-même.', 400, 'SELF_CONTRACT');
  }
  const price = Number(priceNf);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ContractError('Le prix doit être un nombre positif.', 400, 'INVALID_PRICE');
  }
  if (!brief || !String(brief).trim()) {
    throw new ContractError('Le brief ne peut pas être vide.', 400, 'EMPTY_BRIEF');
  }

  const creator = await User.findByPk(creatorUserId);
  if (!creator || creator.subscription_tier !== 'ultra') {
    throw new ContractError('Ce compte n\'est pas (ou plus) éligible aux contrats Ultra.', 404, 'NOT_ULTRA');
  }

  const currency = await getPlatformCurrency();
  if (!currency) throw new ContractError('Le portefeuille NF est momentanément indisponible.', 503, 'CURRENCY_UNAVAILABLE');

  const contract = await CreatorContract.create({
    brand_user_id: brandUserId,
    creator_user_id: creatorUserId,
    price_nf: price,
    currency_id: currency.id,
    brief: String(brief).trim(),
    status: 'pending',
  });

  await notify(
    creatorUserId,
    'Nouvelle proposition de contrat',
    `Une marque te propose un contrat de ${price} NF.`,
    'contract_proposed',
    { contract_id: contract.id }
  );

  return contract;
}

async function loadContractForActor(contractId, userId, allowedRoles = ['brand', 'creator']) {
  const contract = await CreatorContract.findByPk(contractId);
  if (!contract) throw new ContractError('Contrat introuvable', 404, 'CONTRACT_NOT_FOUND');
  const role = contract.brand_user_id === userId ? 'brand'
    : contract.creator_user_id === userId ? 'creator' : null;
  if (!role || !allowedRoles.includes(role)) {
    throw new ContractError('Ce contrat ne vous appartient pas.', 403, 'FORBIDDEN');
  }
  return { contract, role };
}

/** Le créateur répond à la proposition initiale. Accepter verrouille le séquestre (débit marque -> trésor). */
async function respondToProposal({ contractId, creatorUserId, accept, reason }) {
  const { contract } = await loadContractForActor(contractId, creatorUserId, ['creator']);
  if (contract.status !== 'pending') {
    throw new ContractError('Cette proposition n\'est plus en attente de réponse.', 409, 'INVALID_STATUS');
  }

  if (!accept) {
    contract.status = 'rejected';
    await contract.save();
    await notify(contract.brand_user_id, 'Contrat refusé', 'Le créateur a refusé votre proposition de contrat.', 'contract_rejected', { contract_id: contract.id, reason: reason || null });
    return contract;
  }

  const creator = await User.findByPk(creatorUserId);
  if (!creator || creator.subscription_tier !== 'ultra') {
    throw new ContractError('Vous n\'êtes plus éligible aux contrats Ultra.', 403, 'NOT_ULTRA');
  }

  const dbTransaction = await sequelize.transaction();
  try {
    const wallet = await NewEconomyService.getUserWallet(contract.currency_id, contract.brand_user_id, dbTransaction);
    if (wallet.wallet.balance < Number(contract.price_nf)) {
      await dbTransaction.rollback();
      throw new ContractError(
        `La marque n'a pas assez de NF pour ce contrat (${wallet.wallet.balance} disponibles, ${contract.price_nf} requis).`,
        400, 'INSUFFICIENT_BRAND_BALANCE'
      );
    }

    const spendResult = await NewEconomyService.spendCoins(
      contract.brand_user_id,
      contract.currency_id,
      Number(contract.price_nf),
      'contract_escrow',
      `creator_contract_${contract.id}`,
      `Séquestre contrat créateur #${contract.id}`,
      dbTransaction
    );

    contract.status = 'accepted';
    contract.accepted_at = new Date();
    contract.escrow_transaction_id = spendResult.transactionHash || spendResult.transaction?.id || null;
    await contract.save({ transaction: dbTransaction });

    await dbTransaction.commit();
  } catch (error) {
    if (dbTransaction.finished !== 'commit') await dbTransaction.rollback().catch(() => {});
    if (error instanceof ContractError) throw error;
    if (isRiskError(error)) {
      throw new ContractError(error.message, error.httpStatus || 403, error.code || 'RISK_DECLINED');
    }
    logger.error('[creatorContract] échec acceptation:', error);
    throw new ContractError('Le séquestre n\'a pas pu être verrouillé. Le contrat n\'a pas été accepté.', 500, 'ESCROW_FAILED');
  }

  await notify(contract.brand_user_id, 'Contrat accepté', 'Le créateur a accepté votre contrat. Les NF sont séquestrés jusqu\'à validation du livrable.', 'contract_accepted', { contract_id: contract.id });
  return contract;
}

/** Le créateur soumet (ou resoumet) un brouillon du livrable, avant toute publication. */
async function submitDraft({ contractId, creatorUserId, draftContent }) {
  const { contract } = await loadContractForActor(contractId, creatorUserId, ['creator']);
  if (!['accepted', 'changes_requested'].includes(contract.status)) {
    throw new ContractError('Ce contrat n\'attend pas de brouillon pour le moment.', 409, 'INVALID_STATUS');
  }
  if (!draftContent || (!draftContent.text && !(Array.isArray(draftContent.media_urls) && draftContent.media_urls.length))) {
    throw new ContractError('Le brouillon doit contenir un texte ou un média.', 400, 'EMPTY_DRAFT');
  }

  const entry = { type: 'draft', content: draftContent, at: new Date().toISOString() };
  contract.revision_history = [...(contract.revision_history || []), entry];
  contract.draft_content = draftContent;
  contract.status = 'draft_submitted';
  await contract.save();

  await notify(contract.brand_user_id, 'Brouillon à relire', 'Le créateur a soumis un brouillon pour votre contrat.', 'contract_draft_submitted', { contract_id: contract.id });
  return contract;
}

/** La marque revoit le brouillon : approuve (publication immédiate + paiement) ou demande une modification (illimité). */
async function reviewDraft({ contractId, brandUserId, action, feedback }) {
  const { contract } = await loadContractForActor(contractId, brandUserId, ['brand']);
  if (contract.status !== 'draft_submitted') {
    throw new ContractError('Ce contrat n\'a pas de brouillon en attente de revue.', 409, 'INVALID_STATUS');
  }
  if (!['approve', 'request_changes'].includes(action)) {
    throw new ContractError('Action de revue invalide.', 400, 'INVALID_ACTION');
  }

  if (action === 'request_changes') {
    if (!feedback || !String(feedback).trim()) {
      throw new ContractError('Un retour est requis pour demander une modification.', 400, 'EMPTY_FEEDBACK');
    }
    contract.revision_history = [...(contract.revision_history || []), {
      type: 'feedback', feedback: String(feedback).trim(), at: new Date().toISOString(),
    }];
    contract.status = 'changes_requested';
    await contract.save();
    await notify(contract.creator_user_id, 'Modification demandée', 'La marque a demandé une modification sur votre brouillon.', 'contract_changes_requested', { contract_id: contract.id, feedback: String(feedback).trim() });
    return contract;
  }

  // action === 'approve' : publication immédiate + libération du séquestre, dans la même transaction.
  const dbTransaction = await sequelize.transaction();
  try {
    const draft = contract.draft_content || {};
    const tweet = await Tweet.create({
      content: draft.text || '',
      user_id: contract.creator_user_id,
      tweet_type: 'tweet',
      media_urls: Array.isArray(draft.media_urls) ? draft.media_urls : [],
      moderation_status: 'pending',
      sponsored_contract_id: contract.id,
      metadata: {
        source: 'creator_contract',
        pending_processing: true,
      },
    }, { transaction: dbTransaction });

    const rewardResult = await NewEconomyService.rewardUser(
      contract.creator_user_id,
      contract.currency_id,
      Number(contract.price_nf),
      `Paiement contrat créateur #${contract.id}`,
      dbTransaction
    );
    if (!rewardResult.success) {
      throw new ContractError(rewardResult.reason || 'La libération du séquestre a échoué.', 500, 'RELEASE_FAILED');
    }

    contract.status = 'approved';
    contract.tweet_id = tweet.id;
    contract.published_at = new Date();
    contract.release_transaction_id = rewardResult.transaction?.transactionHash || rewardResult.transaction?.id || null;
    await contract.save({ transaction: dbTransaction });

    await dbTransaction.commit();

    // Même pipeline de qualité/modération que n'importe quel autre tweet,
    // hors transaction : un échec ici ne doit jamais annuler le paiement déjà acté.
    try {
      const TweetQueueService = require('./tweetQueueService');
      const tweetQueueService = new TweetQueueService();
      await tweetQueueService.addTweetToQueue(tweet.id, contract.creator_user_id);
    } catch (queueError) {
      logger.error('[creatorContract] ajout à la queue échoué:', queueError.message);
    }
    setImmediate(async () => {
      try {
        const { processPendingTweet } = require('./geminiService');
        const author = await User.findByPk(contract.creator_user_id, { attributes: ['username'] });
        if (author) await processPendingTweet(tweet.id, tweet.content, author.username, false);
      } catch (processError) {
        logger.error('[creatorContract] traitement Gemini échoué:', processError.message);
      }
    });

    await notify(contract.creator_user_id, 'Contrat approuvé et publié', `Votre tweet sponsorisé est publié, ${contract.price_nf} NF ont été crédités.`, 'contract_approved', { contract_id: contract.id, tweet_id: tweet.id });
    return contract;
  } catch (error) {
    if (dbTransaction.finished !== 'commit') await dbTransaction.rollback().catch(() => {});
    if (error instanceof ContractError) throw error;
    logger.error('[creatorContract] échec approbation:', error);
    throw new ContractError('La publication ou le paiement a échoué. Le contrat reste en revue.', 500, 'APPROVAL_FAILED');
  }
}

/** Le créateur annule un contrat bloqué en attente de revue (marque muette) — remboursement intégral. */
async function cancelContract({ contractId, creatorUserId }) {
  const { contract } = await loadContractForActor(contractId, creatorUserId, ['creator']);
  if (contract.status !== 'draft_submitted') {
    throw new ContractError('Seul un contrat en attente de revue peut être annulé par le créateur.', 409, 'INVALID_STATUS');
  }

  const dbTransaction = await sequelize.transaction();
  try {
    const refundResult = await NewEconomyService.rewardUser(
      contract.brand_user_id,
      contract.currency_id,
      Number(contract.price_nf),
      `Remboursement contrat créateur annulé #${contract.id}`,
      dbTransaction
    );
    if (!refundResult.success) {
      throw new ContractError(refundResult.reason || 'Le remboursement a échoué.', 500, 'REFUND_FAILED');
    }

    contract.status = 'cancelled';
    contract.cancelled_at = new Date();
    contract.release_transaction_id = refundResult.transaction?.transactionHash || refundResult.transaction?.id || null;
    await contract.save({ transaction: dbTransaction });
    await dbTransaction.commit();
  } catch (error) {
    if (dbTransaction.finished !== 'commit') await dbTransaction.rollback().catch(() => {});
    if (error instanceof ContractError) throw error;
    logger.error('[creatorContract] échec annulation:', error);
    throw new ContractError('L\'annulation a échoué.', 500, 'CANCEL_FAILED');
  }

  await notify(contract.brand_user_id, 'Contrat annulé', 'Le créateur a annulé le contrat faute de retour de votre part. Vos NF ont été remboursés.', 'contract_cancelled', { contract_id: contract.id });
  return contract;
}

async function getMyContracts({ userId, role }) {
  const where = role === 'brand' ? { brand_user_id: userId }
    : role === 'creator' ? { creator_user_id: userId }
    : { [Op.or]: [{ brand_user_id: userId }, { creator_user_id: userId }] };

  return CreatorContract.findAll({
    where,
    include: [
      { model: User, as: 'brand', attributes: ['id', 'username', 'avatar'] },
      { model: User, as: 'creator', attributes: ['id', 'username', 'avatar'] },
    ],
    order: [['created_at', 'DESC']],
  });
}

async function getContractById({ contractId, userId }) {
  const { contract } = await loadContractForActor(contractId, userId);
  return CreatorContract.findByPk(contract.id, {
    include: [
      { model: User, as: 'brand', attributes: ['id', 'username', 'avatar'] },
      { model: User, as: 'creator', attributes: ['id', 'username', 'avatar'] },
    ],
  });
}

module.exports = {
  ContractError,
  getMarketplace,
  setIndicativePrice,
  proposeContract,
  respondToProposal,
  submitDraft,
  reviewDraft,
  cancelContract,
  getMyContracts,
  getContractById,
};
