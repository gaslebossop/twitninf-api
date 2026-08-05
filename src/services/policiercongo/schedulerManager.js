/**
 * ⏰ Gestionnaire de Planification Dynamique - PolicierCongo
 *
 * Ce module gère les horaires de réveil de PolicierCongo en permettant
 * à l'IA de décider de son prochain passage via le champ next_check_in.
 *
 * ── État partagé entre instances ────────────────────────────────────────────
 * L'horaire était stocké dans `scheduler.json`, à côté du code. Tant que tout
 * tournait sur une machine, ce fichier faisait à la fois office de mémoire et
 * de verrou. Dès que l'API tourne sur plusieurs nœuds, il ne fait plus ni l'un
 * ni l'autre : un administrateur qui réinitialise le planning depuis l'app
 * frappe l'instance web que le répartiteur a choisie, et écrit dans un fichier
 * que le worker ne lira jamais.
 *
 * L'horaire vit donc dans Redis, partagé par tout le parc. Le fichier est
 * conservé comme repli quand Redis est indisponible (et comme source de
 * reprise au premier démarrage après migration), pour qu'une installation
 * mono-serveur sans Redis continue de fonctionner à l'identique.
 *
 * Le démarrage d'un cycle utilise en plus un vrai verrou atomique
 * (`SET … NX PX`) : avancer l'horaire ne protège de rien si deux process
 * lisent « c'est l'heure » dans la même milliseconde.
 */

const fs = require('fs');
const path = require('path');
const redisLib = require('redis');
const logger = require('../../utils/logger');
const appConfig = require('../../config/config');
const { SCHEDULE_CONFIG } = require('./config');

const SCHEDULER_FILE = path.join(__dirname, 'scheduler.json');

/** Horaire du prochain réveil, partagé par toutes les instances. */
const REDIS_KEY = 'policiercongo:scheduler:next_run';
/** Verrou d'exécution : empêche deux cycles simultanés. */
const REDIS_LOCK_KEY = 'policiercongo:scheduler:run_lock';
/** Durée du verrou et du recul d'horaire pendant qu'un cycle tourne. */
const RUN_COOLDOWN_MS = 15 * 60000;

class SchedulerManager {
  constructor() {
    this.nextRunTime = null;
    this.redis = null;
    this.redisReady = false;
    this._connecting = null;
    // Lecture immédiate du fichier : garde `nextRunTime` utilisable de façon
    // synchrone pour le code hérité, avant le premier aller-retour Redis.
    this._loadFromFile();
  }

  /**
   * Client Redis dédié, connecté paresseusement. On n'emprunte pas celui de
   * server.js : ce module est aussi chargé par des scripts hors serveur.
   */
  async _getRedis() {
    if (this.redisReady) return this.redis;
    if (!this._connecting) {
      this._connecting = (async () => {
        const client = redisLib.createClient(appConfig.redis);
        client.on('error', (err) => {
          this.redisReady = false;
          logger.warn(`[scheduler] Redis indisponible: ${err.message}`);
        });
        await client.connect();
        this.redis = client;
        this.redisReady = true;
        return client;
      })().catch((error) => {
        logger.warn(`[scheduler] Connexion Redis échouée, repli fichier: ${error.message}`);
        this._connecting = null;
        return null;
      });
    }
    return this._connecting;
  }

  _loadFromFile() {
    try {
      if (fs.existsSync(SCHEDULER_FILE)) {
        const data = JSON.parse(fs.readFileSync(SCHEDULER_FILE, 'utf8'));
        if (data && data.next_run_time) {
          this.nextRunTime = new Date(data.next_run_time);
        }
      }
    } catch (error) {
      logger.error('❌ Erreur lors du chargement du scheduler (fichier):', error);
      this.nextRunTime = null;
    }
  }

  _saveToFile() {
    try {
      const data = {
        next_run_time: this.nextRunTime ? this.nextRunTime.toISOString() : null,
        updated_at: new Date().toISOString()
      };
      fs.writeFileSync(SCHEDULER_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('❌ Erreur lors de la sauvegarde du scheduler (fichier):', error);
    }
  }

  /**
   * Charge le prochain horaire depuis Redis (source de vérité), avec repli
   * sur le fichier local.
   */
  async load() {
    const client = await this._getRedis();
    if (!client) {
      this._loadFromFile();
      return this.nextRunTime;
    }
    try {
      const value = await client.get(REDIS_KEY);
      if (value) {
        this.nextRunTime = new Date(value);
      } else {
        // Rien dans Redis : première exécution après migration, on reprend la
        // valeur du fichier et on la promeut comme état partagé.
        this._loadFromFile();
        if (this.nextRunTime) await client.set(REDIS_KEY, this.nextRunTime.toISOString());
      }
    } catch (error) {
      logger.warn(`[scheduler] Lecture Redis échouée, repli fichier: ${error.message}`);
      this._loadFromFile();
    }
    return this.nextRunTime;
  }

  /**
   * Sauvegarde le prochain horaire (Redis + fichier de repli).
   */
  async save() {
    this._saveToFile();
    const client = await this._getRedis();
    if (!client) return;
    try {
      if (this.nextRunTime) {
        await client.set(REDIS_KEY, this.nextRunTime.toISOString());
      } else {
        await client.del(REDIS_KEY);
      }
    } catch (error) {
      logger.warn(`[scheduler] Écriture Redis échouée: ${error.message}`);
    }
  }

  /**
   * Vérifie s'il est temps de lancer le cycle
   */
  async isTimeForRun() {
    // 🔄 Force le rechargement pour être en phase avec l'Admin UI, qui peut
    // avoir frappé une autre instance que celle qui exécute le cron.
    await this.load();

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
  async scheduleNextRun(nextCheckIn) {
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
    await this.save();
    // Le cycle est terminé puisqu'on reprogramme le suivant : on rend la main.
    await this._releaseRunLock();
  }

  /**
   * Tente de démarrer un cycle. Renvoie `false` si un autre process l'a déjà
   * démarré — c'est le seul appel à utiliser côté cron.
   *
   * Le verrou est atomique (`SET NX PX`), contrairement au simple recul
   * d'horaire : deux process qui lisent « c'est l'heure » en même temps
   * passeraient tous les deux le test précédent, mais un seul obtient la clé.
   * Il expire tout seul, pour qu'un process tué en plein cycle ne bloque pas
   * PolicierCongo pour toujours.
   *
   * @returns {Promise<boolean>} vrai si ce process a le droit de lancer le cycle
   */
  async tryStartRun() {
    const client = await this._getRedis();
    if (client) {
      try {
        const acquired = await client.set(REDIS_LOCK_KEY, `${process.pid}@${Date.now()}`, {
          NX: true,
          PX: RUN_COOLDOWN_MS
        });
        if (!acquired) {
          logger.info('🔒 [Scheduler] Cycle déjà en cours sur une autre instance, passage ignoré.');
          return false;
        }
      } catch (error) {
        // Redis muet : on retombe sur l'ancien comportement (recul d'horaire),
        // qui protège au moins contre les relances au sein d'un même process.
        logger.warn(`[scheduler] Verrou Redis indisponible: ${error.message}`);
      }
    }
    await this.startRun();
    return true;
  }

  /**
   * Marque le début d'un run pour éviter les lancements multiples
   * (Soft lock : avance l'heure de 15 min par défaut en attendant la décision de l'IA)
   */
  async startRun() {
    this.nextRunTime = new Date(Date.now() + RUN_COOLDOWN_MS);
    await this.save();
    logger.info(`🔒 [Scheduler] Run commencé. Prochain check verrouillé à +15min (${this.nextRunTime.toISOString()})`);
  }

  async _releaseRunLock() {
    const client = await this._getRedis();
    if (!client) return;
    try {
      await client.del(REDIS_LOCK_KEY);
    } catch (error) {
      logger.warn(`[scheduler] Libération du verrou échouée: ${error.message}`);
    }
  }

  /**
   * Reset le scheduler (pour forcer un run)
   */
  async reset() {
    this.nextRunTime = null;
    await this.save();
    // Un reset administrateur doit vraiment débloquer : si un cycle précédent
    // a laissé son verrou derrière lui, on le lève aussi.
    await this._releaseRunLock();
    logger.info('🔄 Scheduler réinitialisé.');
  }

  /**
   * Initialisation au démarrage du serveur.
   * Si la date programmée est dans le passé (ex: le serveur vient de redémarrer),
   * on ne run PAS immédiatement : on programme un délai de grâce pour que le
   * cron prenne le relais proprement.
   * @param {number} [graceMinutes=3] — délai avant le premier run après boot
   */
  async initOnStartup(graceMinutes = 3) {
    await this.load();

    if (!this.nextRunTime || this.nextRunTime <= new Date()) {
      // La date est nulle ou passée → au lieu de run immédiat, on programme un court délai
      const graceDate = new Date(Date.now() + graceMinutes * 60000);
      this.nextRunTime = graceDate;
      await this.save();
      logger.info(`🚀 [Scheduler] Startup : date passée/nulle → premier run dans ${graceMinutes} min (${graceDate.toLocaleString()}) au lieu de run immédiat.`);
    } else {
      const diffMin = Math.round((this.nextRunTime - new Date()) / 60000);
      logger.info(`🚀 [Scheduler] Startup : prochain run déjà programmé dans ${diffMin} min (${this.nextRunTime.toLocaleString()}).`);
    }
  }
}

module.exports = new SchedulerManager();
