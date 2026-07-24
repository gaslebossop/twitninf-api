const { validationResult } = require('express-validator');
const CasinoService = require('../services/casinoService');
const logger = require('../utils/logger');

class CasinoController {
  static getConfig(req, res) {
    res.json({ success: true, data: CasinoService.getConfig() });
  }

  static async playDice(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
      }

      const { currencyId, amount, winChance } = req.body;
      const userId = req.user.id;

      const result = await CasinoService.playDice(userId, currencyId, amount, winChance);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur casino dés:', error);
      res.status(400).json({ success: false, message: error.message || 'Pari refusé' });
    }
  }

  static async playWheel(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Donnees invalides', errors: errors.array() });
      }

      const { currencyId, amount, mode } = req.body;
      const userId = req.user.id;

      const result = await CasinoService.playWheel(userId, currencyId, amount, mode);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur casino roue:', error);
      res.status(400).json({ success: false, message: error.message || 'Pari refuse' });
    }
  }

  static async playCoinflip(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
      }

      const { currencyId, amount, choice } = req.body;
      const userId = req.user.id;

      const result = await CasinoService.playCoinflip(userId, currencyId, amount, choice);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur casino pile ou face:', error);
      res.status(400).json({ success: false, message: error.message || 'Pari refusé' });
    }
  }

  static async playSlots(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
      }

      const { currencyId, amount } = req.body;
      const userId = req.user.id;

      const result = await CasinoService.playSlots(userId, currencyId, amount);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur casino machine à sous:', error);
      res.status(400).json({ success: false, message: error.message || 'Pari refusé' });
    }
  }

  static async getHistory(req, res) {
    try {
      const userId = req.user.id;
      const history = await CasinoService.getHistory(userId, req.query.limit);
      res.json({ success: true, data: history });
    } catch (error) {
      logger.error('Erreur historique casino:', error);
      res.status(500).json({ success: false, message: 'Erreur lors de la récupération de l’historique' });
    }
  }
}

module.exports = CasinoController;
