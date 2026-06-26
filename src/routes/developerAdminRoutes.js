const express = require('express');
const { body, validationResult } = require('express-validator');
const { DeveloperApp } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const crypto = require('crypto');

const router = express.Router();

// Middleware pour toutes les routes dev: requiert d'être connecté
router.use(authenticateToken);

// Récupérer toutes les applications du développeur
router.get('/', async (req, res) => {
  try {
    const apps = await DeveloperApp.findAll({ where: { user_id: req.user.id } });
    res.json({ success: true, count: apps.length, data: apps });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Créer une nouvelle application
const createValidation = [
  body('name').isLength({ min: 3, max: 50 }).withMessage('Le nom doit contenir entre 3 et 50 caractères'),
  body('description').optional().isLength({ max: 500 }).withMessage('La description est trop longue'),
  body('redirect_uris').optional().isArray().withMessage('Les URI de redirection doivent être un tableau')
];
router.post('/', createValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { name, description, redirect_uris } = req.body;
    
    // Génération automatique des clés
    const client_id = 'tw_dev_' + crypto.randomBytes(12).toString('hex');
    const client_secret = crypto.randomBytes(32).toString('hex');

    const app = await DeveloperApp.create({
      user_id: req.user.id,
      name,
      description,
      client_id,
      client_secret,
      redirect_uris: redirect_uris || []
    });

    res.status(201).json({ success: true, data: app });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ success: false, message: 'Ce nom d\'application est déjà utilisé. Veuillez en choisir un autre.' });
    }
    res.status(500).json({ success: false, message: 'Erreur lors de la création' });
  }
});

// Réinitialiser le client_secret
router.put('/:id/reset-secret', async (req, res) => {
  try {
    const app = await DeveloperApp.findOne({ where: { id: req.params.id, user_id: req.user.id } });
    if (!app) return res.status(404).json({ success: false, message: 'App introuvable' });

    app.client_secret = crypto.randomBytes(32).toString('hex');
    await app.save();

    res.json({ success: true, data: app });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la réinitialisation' });
  }
});

// Supprimer l'application
router.delete('/:id', async (req, res) => {
  try {
    const app = await DeveloperApp.findOne({ where: { id: req.params.id, user_id: req.user.id } });
    if (!app) return res.status(404).json({ success: false, message: 'App introuvable' });

    // Ceci va aussi supprimer en cascade les tokens et les codes via les contraintes de DB
    await app.destroy();

    res.json({ success: true, message: 'Application supprimée' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur de suppression' });
  }
});

module.exports = router;
