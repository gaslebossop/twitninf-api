const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { sequelize } = require('../../models');

const INSTRUCT_FILE_PATH = path.join(__dirname, 'instruct.json');

class InstructionManager {
  constructor() {
    this.instructions = {
      personality: [],
      immediate_orders: []
    };
    this.load();
  }

  async loadFromDb() {
    try {
      const [rows] = await sequelize.query(
        `
        SELECT id, instruction_type, text, admin_id, status, created_at
        FROM policiercongo_instructions
        WHERE status IN ('pending', 'executed')
        ORDER BY created_at ASC
        `
      );

      const personality = [];
      const immediate_orders = [];
      for (const r of rows) {
        const entry = {
          id: Number(r.id),
          text: r.text,
          adminId: r.admin_id,
          createdAt: r.created_at,
          status: r.status
        };
        if (r.instruction_type === 'personality') personality.push(entry);
        else immediate_orders.push(entry);
      }

      this.instructions = { personality, immediate_orders };
      return true;
    } catch (error) {
      logger.warn(`⚠️ Chargement DB instructions impossible: ${error.message}`);
      return false;
    }
  }

  async saveToDb() {
    try {
      await sequelize.transaction(async (t) => {
        await sequelize.query(`DELETE FROM policiercongo_instructions`, { transaction: t });

        for (const p of this.instructions.personality) {
          await sequelize.query(
            `
            INSERT INTO policiercongo_instructions
            (instruction_type, text, admin_id, status, created_at, updated_at)
            VALUES ('personality', :text, :adminId, 'pending', :createdAt, NOW())
            `,
            {
              transaction: t,
              replacements: {
                text: p.text,
                adminId: p.adminId || null,
                createdAt: p.createdAt || new Date()
              }
            }
          );
        }

        for (const o of this.instructions.immediate_orders) {
          await sequelize.query(
            `
            INSERT INTO policiercongo_instructions
            (instruction_type, text, admin_id, status, created_at, updated_at)
            VALUES ('immediate_order', :text, :adminId, :status, :createdAt, NOW())
            `,
            {
              transaction: t,
              replacements: {
                text: o.text,
                adminId: o.adminId || null,
                status: o.status || 'pending',
                createdAt: o.createdAt || new Date()
              }
            }
          );
        }
      });
      return true;
    } catch (error) {
      logger.warn(`⚠️ Sauvegarde DB instructions impossible: ${error.message}`);
      return false;
    }
  }

  /**
   * Charge les instructions depuis le fichier
   */
  load() {
    try {
      if (fs.existsSync(INSTRUCT_FILE_PATH)) {
        const data = fs.readFileSync(INSTRUCT_FILE_PATH, 'utf8');
        this.instructions = JSON.parse(data);
        logger.info('📖 Instructions PolicierCongo chargées avec succès');
      } else {
        this.save(); // Créer le fichier par défaut
      }
      // Prioriser DB si disponible
      this.loadFromDb();
    } catch (error) {
      logger.error('❌ Erreur lors du chargement des instructions PolicierCongo:', error);
    }
  }

  /**
   * Sauvegarde les instructions dans le fichier
   */
  save() {
    try {
      fs.writeFileSync(INSTRUCT_FILE_PATH, JSON.stringify(this.instructions, null, 2));
      this.saveToDb();
      logger.info('💾 Instructions PolicierCongo sauvegardées');
    } catch (error) {
      logger.error('❌ Erreur lors de la sauvegarde des instructions PolicierCongo:', error);
    }
  }

  /**
   * Ajoute une instruction de personnalité (persistante)
   */
  addPersonalityInstruction(text, adminId) {
    this.instructions.personality.push({
      id: Date.now(),
      text,
      adminId,
      createdAt: new Date().toISOString()
    });
    this.save();
  }

  /**
   * Ajoute un ordre immédiat (one-shot)
   */
  addImmediateOrder(text, adminId) {
    this.instructions.immediate_orders.push({
      id: Date.now(),
      text,
      adminId,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });
    this.save();
  }

  /**
   * Récupère les instructions formatées pour le prompt Gemini
   */
  getFormattedInstructions() {
    let prompt = '';

    if (this.instructions.personality.length > 0) {
      prompt += '\n🚨 DIRECTIVES DE PERSONNALITÉ (RÈGLES D\'OR):\n';
      this.instructions.personality.forEach((inst, i) => {
        prompt += `${i + 1}. ${inst.text}\n`;
      });
    }

    const pendingOrders = this.instructions.immediate_orders.filter(o => o.status === 'pending');
    if (pendingOrders.length > 0) {
      prompt += '\n👑 ORDRES ADMINISTRATIFS PRIORITAIRES (EXÉCUTION IMMÉDIATE):\n';
      pendingOrders.forEach((order, i) => {
        prompt += `${i + 1}. ${order.text}\n`;
      });
    }

    return prompt;
  }

  /**
   * Marque tous les ordres "pending" comme "executed"
   */
  markOrdersAsExecuted() {
    const beforeCount = this.instructions.immediate_orders.length;
    
    // Supprimer tous les ordres (ceux qui étaient en attente sont maintenant traités)
    // On ne garde plus d'historique du tout pour les ordres immédiats (instantanés)
    this.instructions.immediate_orders = [];

    if (beforeCount > 0) {
      this.save();
      logger.info(`🗑️ Historique des ordres immédiats vidé (${beforeCount} ordres supprimés)`);
    }
  }

  /**
   * Supprime une instruction de personnalité par son ID
   */
  removePersonalityInstruction(id) {
    this.instructions.personality = this.instructions.personality.filter(i => i.id !== id);
    this.save();
  }

  /**
   * Récupère toutes les instructions (brutes)
   */
  getAll() {
    return this.instructions;
  }
}

module.exports = new InstructionManager();
