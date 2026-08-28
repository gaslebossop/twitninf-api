const express = require('express');
const router = express.Router();

const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const contractService = require('../services/creatorContractService');
const logger = require('../utils/logger');

function handleContractError(res, error, fallbackMessage) {
  if (error instanceof contractService.ContractError) {
    return res.status(error.httpStatus).json({ success: false, message: error.message, code: error.code });
  }
  logger.error('[contractRoutes]', error);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

/** GET /api/contracts/marketplace — créateurs Ultra ouverts aux contrats. */
router.get('/marketplace', [authenticateToken], async (req, res) => {
  try {
    const { search, min_price: minPrice, max_price: maxPrice, limit, offset } = req.query;
    const result = await contractService.getMarketplace({
      search,
      minPrice: minPrice != null ? Number(minPrice) : null,
      maxPrice: maxPrice != null ? Number(maxPrice) : null,
      limit,
      offset,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handleContractError(res, error, 'Impossible de charger la marketplace.');
  }
});

/** PUT /api/contracts/me/indicative-price — prix indicatif affiché sur la marketplace. */
router.put('/me/indicative-price', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const price = await contractService.setIndicativePrice(req.user.id, req.body?.price_nf);
    res.json({ success: true, data: { ultra_indicative_price_nf: price } });
  } catch (error) {
    handleContractError(res, error, 'Impossible de mettre à jour le prix indicatif.');
  }
});

/** GET /api/contracts — mes contrats (brand|creator|tous). */
router.get('/', [authenticateToken], async (req, res) => {
  try {
    const contracts = await contractService.getMyContracts({ userId: req.user.id, role: req.query.role });
    res.json({ success: true, data: contracts });
  } catch (error) {
    handleContractError(res, error, 'Impossible de charger vos contrats.');
  }
});

/** GET /api/contracts/:id */
router.get('/:id', [authenticateToken], async (req, res) => {
  try {
    const contract = await contractService.getContractById({ contractId: req.params.id, userId: req.user.id });
    res.json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'Impossible de charger ce contrat.');
  }
});

/** POST /api/contracts — proposer un contrat à un créateur Ultra. */
router.post('/', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const { creator_id: creatorId, price_nf: priceNf, brief } = req.body || {};
    const contract = await contractService.proposeContract({
      brandUserId: req.user.id,
      creatorUserId: creatorId,
      priceNf,
      brief,
    });
    res.status(201).json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'La proposition de contrat a échoué.');
  }
});

/** POST /api/contracts/:id/respond — le créateur accepte/refuse. */
router.post('/:id/respond', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const contract = await contractService.respondToProposal({
      contractId: req.params.id,
      creatorUserId: req.user.id,
      accept: !!req.body?.accept,
      reason: req.body?.reason,
    });
    res.json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'La réponse au contrat a échoué.');
  }
});

/** POST /api/contracts/:id/draft — le créateur soumet/resoumet un brouillon. */
router.post('/:id/draft', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const contract = await contractService.submitDraft({
      contractId: req.params.id,
      creatorUserId: req.user.id,
      draftContent: req.body?.draft_content,
    });
    res.json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'La soumission du brouillon a échoué.');
  }
});

/** POST /api/contracts/:id/review — la marque approuve ou demande une modification. */
router.post('/:id/review', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const contract = await contractService.reviewDraft({
      contractId: req.params.id,
      brandUserId: req.user.id,
      action: req.body?.action,
      feedback: req.body?.feedback,
    });
    res.json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'La revue du brouillon a échoué.');
  }
});

/** POST /api/contracts/:id/cancel — le créateur annule un contrat bloqué (marque muette), remboursement intégral. */
router.post('/:id/cancel', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const contract = await contractService.cancelContract({
      contractId: req.params.id,
      creatorUserId: req.user.id,
    });
    res.json({ success: true, data: contract });
  } catch (error) {
    handleContractError(res, error, 'L\'annulation a échoué.');
  }
});

module.exports = router;
