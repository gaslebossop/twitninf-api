/**
 * 🔓 Script de déblocage massif - Bot AI Mitigation
 * 
 * Ce script débloque tous les utilisateurs qui ont été suspendus par
 * le système de détection de bot avec le motif 'bot_ai'.
 */

const { User, sequelize } = require('./src/models');
const logger = require('./src/utils/logger');

async function unbanBotAiUsers() {
  console.log('🚀 Démarrage du déblocage massif des utilisateurs bannis par l\'IA...');
  
  try {
    // 1. Trouver tous les utilisateurs suspendus par le bot
    const botAiUsers = await User.findAll({
      where: {
        is_suspended: true,
        suspension_reason: 'bot_ai'
      }
    });

    console.log(`🔍 Trouvé ${botAiUsers.length} utilisateurs suspendus par 'bot_ai'`);

    if (botAiUsers.length === 0) {
      console.log('✅ Aucun utilisateur à débloquer avec ce motif.');
      return;
    }

    // 2. Débloquer les utilisateurs
    const [affectedCount] = await User.update({
      is_suspended: false,
      suspended_at: null,
      suspended_until: null,
      suspension_reason: null,
      // On réduit le ban_count car c'était probablement une erreur
      ban_count: sequelize.literal('GREATEST(0, ban_count - 1)')
    }, {
      where: {
        is_suspended: true,
        suspension_reason: 'bot_ai'
      }
    });

    console.log(`✅ Succès ! ${affectedCount} utilisateurs ont été débloqués.`);
    logger.info(`🔓 [MASS UNBAN] ${affectedCount} utilisateurs débloqués (motif: bot_ai)`);

  } catch (error) {
    console.error('❌ Erreur lors du déblocage massif:', error);
    logger.error('❌ Erreur lors du déblocage massif:', error);
  } finally {
    process.exit(0);
  }
}

unbanBotAiUsers();
