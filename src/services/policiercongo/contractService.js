/**
 * 📜 Contrats PolicierCongo
 *
 * Un utilisateur vérifié peut créer un contrat en DM avec /createcontrat <texte>.
 * Les messages échangés ensuite dans ce DM sont capturés dans le contrat tant
 * qu'il est en attente. PolicierCongo l'accepte ou le refuse via un tool :
 * - accepté  → le contrat est figé (fin de capture), sert de preuve/justificatif.
 * - refusé   → le contrat est supprimé (lui et sa copie de messages), le DM
 *              lui-même n'est jamais touché.
 */
const { PolicierCongoContract, User } = require('../../models');
const { POLICE_ACCOUNT_ID } = require('./config');
const logger = require('../../utils/logger');

const CREATE_COMMAND = /^\/createcontrat\b\s*/i;

function isCreateContractCommand(text) {
  return CREATE_COMMAND.test(String(text || '').trim());
}

function extractContractText(text) {
  return String(text || '').trim().replace(CREATE_COMMAND, '').trim();
}

/**
 * Crée un contrat si l'expéditeur est vérifié et le texte non vide.
 * Retourne null si la commande n'a pas pu créer de contrat (non vérifié,
 * texte vide) — l'appelant décide quoi répondre dans ce cas.
 */
async function tryCreateContract({ senderUser, conversationId, text }) {
  if (!isCreateContractCommand(text)) return null;
  if (!senderUser?.verified) {
    return { error: 'not_verified' };
  }
  const contractText = extractContractText(text);
  if (!contractText) {
    return { error: 'empty_text' };
  }
  const contract = await PolicierCongoContract.create({
    creatorUserId: senderUser.id,
    conversationId,
    contractText,
    status: 'pending',
    messages: []
  });
  logger.info(`📜 Contrat ${contract.id} créé par ${senderUser.username} dans conv ${conversationId}`);
  return { contract };
}

/**
 * Ajoute un message à la copie du contrat en attente de cette conversation,
 * s'il y en a un. No-op silencieux sinon (cas normal, la plupart des DMs
 * n'ont pas de contrat en cours).
 */
async function captureMessage(conversationId, { senderId, senderUsername, content }) {
  try {
    const contract = await PolicierCongoContract.findOne({
      where: { conversationId, status: 'pending' }
    });
    if (!contract) return;
    const messages = Array.isArray(contract.messages) ? contract.messages : [];
    messages.push({
      sender_id: senderId,
      sender_username: senderUsername || null,
      content,
      at: new Date().toISOString()
    });
    await contract.update({ messages });
  } catch (error) {
    logger.warn('⚠️ Capture message contrat échouée:', error.message);
  }
}

async function getPendingContractForConversation(conversationId) {
  return PolicierCongoContract.findOne({ where: { conversationId, status: 'pending' } });
}

async function getContract(contractId) {
  return PolicierCongoContract.findByPk(contractId);
}

async function acceptContract(contractId, reason) {
  const contract = await PolicierCongoContract.findByPk(contractId);
  if (!contract) throw new Error('Contrat introuvable');
  if (contract.status !== 'pending') throw new Error(`Contrat déjà ${contract.status}`);
  await contract.update({ status: 'accepted', decidedAt: new Date(), decisionReason: reason || null });
  return contract;
}

async function refuseContract(contractId, reason) {
  const contract = await PolicierCongoContract.findByPk(contractId);
  if (!contract) throw new Error('Contrat introuvable');
  if (contract.status !== 'pending') throw new Error(`Contrat déjà ${contract.status}`);
  // Refus = suppression du contrat et de sa copie de messages. Le DM d'origine
  // n'est jamais touché (voir docstring en tête de fichier).
  await contract.destroy();
  return { id: contractId, reason };
}

module.exports = {
  isCreateContractCommand,
  tryCreateContract,
  captureMessage,
  getPendingContractForConversation,
  getContract,
  acceptContract,
  refuseContract
};
