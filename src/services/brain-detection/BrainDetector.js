const axios = require('axios');
const logger = require('../../utils/logger');

class BrainDetector {
  constructor() {
    this.serverUrl = 'http://127.0.0.1:6789';
    this.isLoaded = true;
  }

  async loadModel() {
    try {
        const response = await axios.get(`${this.serverUrl}/health`, { timeout: 1000 });
        return response.data.status === 'ok';
    } catch (e) {
        return false;
    }
  }

  async predict(features) {
    try {
        // --- LOG DE DIAGNOSTIC FORCE ---
        logger.info(`📡 [BotBrain-Debug] Envoi des caractéristiques à l'IA : ${JSON.stringify(features)}`);
        
        const response = await axios.post(`${this.serverUrl}/predict`, features, {
            timeout: 5000 // On augmente le timeout pour le debug
        });

        if (response.data.score === 0) {
            logger.warn('⚠️ [BotBrain-Debug] L\'IA a renvoyé un score de 0%. Vérifier si le modèle est bien à jour sur le VPS.');
        }

        return response.data;
    } catch (e) {
        logger.error('❌ [BotBrain-Debug] Erreur de communication IA :', {
            message: e.message,
            stack: e.stack,
            url: this.serverUrl
        });
        return { botProbability: 0, isBot: false, error: 'OFFLINE' };
    }
  }
}

module.exports = new BrainDetector();
