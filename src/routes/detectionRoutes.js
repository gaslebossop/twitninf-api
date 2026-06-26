const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// S'assurer que le dossier storage existe
const storageDir = path.join(__dirname, '../../storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

/**
 * GET /api/detection
 * Route de test pour enregistrer les requêtes dans un fichier JSON
 */
router.all('/', (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    const query = req.query;
    const body = req.body;
    const headers = req.headers;
    const method = req.method;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    const entry = {
      timestamp,
      method,
      ip,
      query,
      body: Object.keys(body).length > 0 ? body : undefined,
      headers: {
        'user-agent': headers['user-agent'],
        'content-type': headers['content-type'],
        'user-platform': headers['user-platform'] || 'unknown'
      }
    };

    const filePath = path.join(storageDir, 'detections.json');

    let detections = [];
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        detections = JSON.parse(fileContent);
        if (!Array.isArray(detections)) detections = [];
      } catch (e) {
        logger.warn('Erreur lors de la lecture de detections.json, réinitialisation...', e);
        detections = [];
      }
    }

    detections.push(entry);

    // Limiter à 1000 entrées pour éviter que le fichier ne devienne trop gros
    if (detections.length > 1000) {
      detections = detections.slice(-1000);
    }

    fs.writeFileSync(filePath, JSON.stringify(detections, null, 2));

    logger.info(`[Detection] Nouvelle requête enregistrée: ${method} - ${timestamp}`);

    res.status(200).json({
      success: true,
      message: 'OK',
      timestamp: timestamp,
      received: {
        query: query
      }
    });
  } catch (error) {
    logger.error('Erreur dans la route de détection:', error);
    res.status(500).json({
      success: false,
      message: 'Internal Server Error',
      error: error.message
    });
  }
});

module.exports = router;
