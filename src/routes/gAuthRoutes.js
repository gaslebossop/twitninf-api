const express = require('express');
const gAuthController = require('../controllers/gAuthController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

// Connexion ou association de compte via g-auth (voir gAuthService.js).
router.get('/start', gAuthController.start);
router.get('/callback', gAuthController.callback);
router.post('/link-token', authenticateToken, gAuthController.linkToken);

// Appelé par g-auth quand l'utilisateur retire l'accès de l'app depuis son
// panel. Pas `authenticateToken` : l'appelant est le serveur g-auth, pas un
// utilisateur — il s'authentifie avec le secret de canal retour.
router.post('/backchannel', gAuthController.backchannel);

module.exports = router;
