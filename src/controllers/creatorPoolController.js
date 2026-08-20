/**
 * Contrôleur du pot créateur.
 *
 * Se contente de traduire HTTP ↔ service : tout ce qui décide d'un montant
 * vit dans `economy/creatorPool/`. Une règle de calcul écrite ici finirait par
 * diverger de celle qu'applique la clôture, et c'est exactement ce qui
 * produisait un montant affiché différent du montant versé.
 */

const { validationResult } = require('express-validator');
const creatorPool = require('../economy/creatorPool');
const { getSettings, updateSettings } = require('../economy/creatorPool/settings');
const ContentQualityService = require('../services/contentQualityService');
const logger = require('../utils/logger');

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

class CreatorPoolController {
  static async getDashboard(req, res) {
    try {
      const data = await creatorPool.getDashboard(req.user.id);
      res.json({ success: true, data });
    } catch (error) {
      logger.error('[creatorPool] tableau de bord indisponible:', error);
      fail(res, 500, 'Impossible de charger tes gains pour le moment');
    }
  }

  /**
   * Encaisse une période, ou toutes celles qui attendent.
   *
   * Les périodes sont encaissées une par une, chacune dans sa propre
   * transaction : si la trésorerie devient insuffisante en cours de route, ce
   * qui a été versé le reste et le reste demeure réclamable — plutôt qu'un
   * rollback qui ferait disparaître un versement déjà notifié.
   */
  static async claim(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return fail(res, 400, 'Période invalide', { errors: errors.array() });
    }

    try {
      const userId = req.user.id;
      const requested = req.body?.periodKey || null;

      let periods;
      if (requested) {
        periods = [requested];
      } else {
        const payouts = await creatorPool.listPayouts(userId, { limit: 52 });
        periods = payouts.filter((p) => p.status === 'claimable').map((p) => p.period_key);
      }

      if (periods.length === 0) {
        return fail(res, 400, 'Aucune part à encaisser pour le moment');
      }

      const results = [];
      let total = 0;
      for (const periodKey of periods) {
        const result = await creatorPool.claim(userId, periodKey);
        results.push({ periodKey, ...result });
        if (result.success) total += result.amount;
      }

      const claimed = results.filter((r) => r.success);
      if (claimed.length === 0) {
        return fail(res, 400, results[0]?.reason || 'Encaissement impossible', { results });
      }

      res.json({
        success: true,
        message: claimed.length === 1
          ? `${total.toFixed(2)} encaissés`
          : `${total.toFixed(2)} encaissés sur ${claimed.length} périodes`,
        data: { total, claimed: claimed.length, results },
      });
    } catch (error) {
      logger.error('[creatorPool] encaissement impossible:', error);
      fail(res, 500, 'Encaissement impossible pour le moment');
    }
  }

  static async getAccountStatus(req, res) {
    try {
      const data = await ContentQualityService.getAccountStatus(req.user.id);
      res.json({ success: true, data });
    } catch (error) {
      logger.error('[creatorPool] état du compte indisponible:', error);
      fail(res, 500, 'Impossible de charger l\'état de ton compte');
    }
  }

  // ---- Administration -----------------------------------------------------

  static async getPeriodBreakdown(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail(res, 400, 'Période invalide');

    try {
      const p = creatorPool.period.fromKey(req.params.key);
      if (!p) return fail(res, 400, 'Période invalide');
      const data = await creatorPool.computePeriodBreakdown(p);
      res.json({ success: true, data });
    } catch (error) {
      logger.error('[creatorPool] détail de période indisponible:', error);
      fail(res, 500, 'Calcul impossible');
    }
  }

  static async closePeriod(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return fail(res, 400, 'Période invalide');

    try {
      const result = await creatorPool.closePeriod({ periodKey: req.body?.periodKey || null });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[creatorPool] clôture impossible:', error);
      fail(res, 400, error.message);
    }
  }

  static async getSettings(req, res) {
    try {
      const settings = await getSettings({ fresh: true });
      res.json({ success: true, data: settings });
    } catch (error) {
      fail(res, 500, 'Réglages illisibles');
    }
  }

  static async updateSettings(req, res) {
    try {
      const settings = await updateSettings(req.body || {});
      logger.info(`[creatorPool] réglages modifiés par ${req.user.username || req.user.id}`);
      res.json({ success: true, data: settings });
    } catch (error) {
      logger.error('[creatorPool] réglages non enregistrés:', error);
      fail(res, 500, 'Réglages non enregistrés');
    }
  }
}

module.exports = CreatorPoolController;
