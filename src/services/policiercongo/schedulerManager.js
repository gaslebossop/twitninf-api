/**
 * ⏰ Gestionnaire de Planification Dynamique - PolicierCongo
 * 
 * Ce module gère les horaires de réveil de PolicierCongo en permettant
 * à l'IA de décider de son prochain passage via le champ next_check_in.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { SCHEDULE_CONFIG } = require('./config');

const SCHEDULER_FILE = path.join(__dirname, 'scheduler.json');

class SchedulerManager {
  constructor() {
    this.nextRunTime = null;
    this.load();
  }

  /**
   * Charge le prochain horaire depuis le fichier JSON
   */
  load() {
    try {
      if (fs.existsSync(SCHEDULER_FILE)) {
        const data = JSON.parse(fs.readFileSync(SCHEDULER_FILE, 'utf8'));
        if (data && data.next_run_time) {
          this.nextRunTime = new Date(data.next_run_time);
        }
      }
    } catch (error) {
      logger.error('❌ Erreur lors du chargement du scheduler:', error);
      this.nextRunTime = null;
    }
  }

  /**
   * Sauvegarde le prochain horaire
   */
  save() {
    try {
      const data = {
        next_run_time: this.nextRunTime ? this.nextRunTime.toISOString() : null,
        updated_at: new Date().toISOString()
      };
      fs.writeFileSync(SCHEDULER_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('❌ Erreur lors de la sauvegarde du scheduler:', error);
    }
  }

  /**
   * Vérifie s'il est temps de lancer le cycle
   */
  isTimeForRun() {
    // 🔄 Force le rechargement depuis le disque pour être en phase avec l'Admin UI
    this.load();
    
    if (!this.nextRunTime) return true;
    
    const now = new Date();
    const isPast = now >= this.nextRunTime;
    
    const diffMs = this.nextRunTime - now;
    const diffMin = Math.round(diffMs / 60000);

    // Logging détaillé pour debug timezone / drift
    logger.info(`⏰ [Scheduler] Check: ServerTime=${now.toISOString()}, Scheduled=${this.nextRunTime.toISOString()}, Diff=${diffMin}min, isPast=${isPast}`);

    return isPast;
  }

  /**
   * Planifie le prochain passage
   * @param {string|Date|null} nextCheckIn 
   */
  scheduleNextRun(nextCheckIn) {
    if (!nextCheckIn) {
      // Fallback sur l'intervalle par défaut si l'IA ne précise rien
      const defaultInterval = SCHEDULE_CONFIG.mainInterval || (2 * 60 * 60 * 1000);
      this.nextRunTime = new Date(Date.now() + defaultInterval);
      logger.info(`ℹ️ Pas de date fournie par l'IA, prochain run par défaut dans ${defaultInterval / (60000 * 60)}h`);
    } else {
      const candidate = new Date(nextCheckIn);
      // Sécurité : maximum 24h et minimum 5min pour éviter les blocages ou boucles
      const now = Date.now();
      const minRun = now + (5 * 60000);
      const maxRun = now + (24 * 60 * 60000);
      
      let finalDate = candidate;
      if (candidate.getTime() < minRun) finalDate = new Date(minRun);
      if (candidate.getTime() > maxRun) finalDate = new Date(maxRun);
      
      this.nextRunTime = finalDate;
      logger.info(`🎯 Prochain réveil programmé par l'IA : ${this.nextRunTime.toLocaleString()}`);
    }
    this.save();
  }

  /**
   * Marque le début d'un run pour éviter les lancements multiples
   * (Soft lock : avance l'heure de 15 min par défaut en attendant la décision de l'IA)
   */
  startRun() {
    const cooldown = 15 * 60000; // 15 minutes de sécurité
    this.nextRunTime = new Date(Date.now() + cooldown);
    this.save();
    logger.info(`🔒 [Scheduler] Run commencé. Prochain check verrouillé à +15min (${this.nextRunTime.toISOString()})`);
  }

  /**
   * Reset le scheduler (pour forcer un run)
   */
  reset() {
    this.nextRunTime = null;
    this.save();
    logger.info('🔄 Scheduler réinitialisé.');
  }

  /**
   * Initialisation au démarrage du serveur.
   * Si la date programmée est dans le passé (ex: le serveur vient de redémarrer),
   * on ne run PAS immédiatement : on programme un délai de grâce pour que le
   * cron prenne le relais proprement.
   * @param {number} [graceMinutes=3] — délai avant le premier run après boot
   */
  initOnStartup(graceMinutes = 3) {
    this.load();

    if (!this.nextRunTime || this.nextRunTime <= new Date()) {
      // La date est nulle ou passée → au lieu de run immédiat, on programme un court délai
      const graceDate = new Date(Date.now() + graceMinutes * 60000);
      this.nextRunTime = graceDate;
      this.save();
      logger.info(`🚀 [Scheduler] Startup : date passée/nulle → premier run dans ${graceMinutes} min (${graceDate.toLocaleString()}) au lieu de run immédiat.`);
    } else {
      const diffMin = Math.round((this.nextRunTime - new Date()) / 60000);
      logger.info(`🚀 [Scheduler] Startup : prochain run déjà programmé dans ${diffMin} min (${this.nextRunTime.toLocaleString()}).`);
    }
  }
}

module.exports = new SchedulerManager();
