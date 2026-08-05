const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const instructionManager = require('../services/policiercongo/InstructionManager');
const policiercongoAutomatisation = require('../services/policiercongoAutomatisation');
const { memoryManager } = require('../services/policiercongo');
const { getPgPool } = require('../services/policiercongo/policiercongoV2Bridge');
const schedulerManager = require('../services/policiercongo/schedulerManager');
const { authenticateToken, requireAdminRole } = require('../middleware/authMiddleware');

/**
 * 🛡️ Middleware de protection Admin/SuperAdmin
 */
const adminOnly = requireAdminRole;

/**
 * 📋 Récupère toutes les instructions actuelles
 * GET /api/admin/policiercongo/instructions
 */
router.get('/instructions', authenticateToken, adminOnly, (req, res) => {
  try {
    const instructions = instructionManager.getAll();
    res.json({
      success: true,
      instructions: instructions
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des instructions PolicierCongo:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * ⚡ Envoie une nouvelle instruction ou un ordre
 * POST /api/admin/policiercongo/instruct
 */
router.post('/instruct', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { text, type } = req.body; // type: 'immediate' | 'personality'
    const adminId = req.user.id;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'L\'instruction ne peut pas être vide' });
    }

    if (type === 'personality') {
      instructionManager.addPersonalityInstruction(text, adminId);
      logger.info(`🎭 Nouvelle directive de personnalité ajoutée par l'admin ${adminId}: ${text}`);
      
      return res.json({
        success: true,
        message: 'Directive de personnalité enregistrée avec succès'
      });
    } else {
      // Ordre immédiat
      instructionManager.addImmediateOrder(text, adminId);
      logger.info(`👑 Nouvel ordre immédiat reçu de l'admin ${adminId}: ${text}`);
      
      // 🚀 Déclencher l'exécution instantanée
      logger.info('⚡ Déclencheur: Exécution instantanée de PolicierCongo suite à un ordre Admin...');
      
      // Utiliser runOptimizedAutomation pour un cycle complet
      // On le lance de manière asynchrone pour ne pas bloquer la réponse HTTP
      policiercongoAutomatisation.runOptimizedAutomation().then(result => {
        if (result && result.success) {
          logger.info(`✅ Ordre Admin exécuté avec succès: ${result.summary}`);
          // L'engine marque désormais les ordres comme exécutés automatiquement
        } else {
          logger.warn('⚠️ Échec ou exécution partielle de l\'ordre Admin');
        }
      }).catch(err => {
        logger.error('❌ Erreur lors de l\'exécution de l\'ordre Admin:', err);
      });

      return res.json({
        success: true,
        message: 'Ordre reçu et exécution instantanée lancée'
      });
    }
  } catch (error) {
    logger.error('❌ Erreur lors de l\'envoi de l\'ordre PolicierCongo:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 🗑️ Supprime une directive de personnalité
 * DELETE /api/admin/policiercongo/personality/:id
 */
router.delete('/personality/:id', authenticateToken, adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    instructionManager.removePersonalityInstruction(id);
    res.json({ success: true, message: 'Directive supprimée avec succès' });
  } catch (error) {
    logger.error('❌ Erreur lors de la suppression de la directive:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 📥 Récupère la mémoire persistée de PolicierCongo
 * (bigContexts du cycle, personalityProfile, lastActions)
 * GET /api/admin/policiercongo/memory
 */
router.get('/memory', authenticateToken, adminOnly, async (req, res) => {
  try {
    const mem = memoryManager.getMemory();

    const memory = {
      communityMood: mem?.communityMood ?? 'neutral',
      priorities: Array.isArray(mem?.priorities) ? mem.priorities : [],
      personalityProfile: mem?.personalityProfile ?? null,
      lastActions: Array.isArray(mem?.lastActions) ? mem.lastActions : [],
      bigContexts: Array.isArray(mem?.bigContexts) ? mem.bigContexts : [],
      lastUpdated: mem?.lastUpdated ?? null,
      lastAnalysis: mem?.lastAnalysis ?? null
    };

    res.json({ success: true, memory });
  } catch (error) {
    logger.error('❌ Erreur récupération mémoire PolicierCongo:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * ➕ Ajouter un big context manuel (keywords) en mémoire DB
 * POST /api/admin/policiercongo/memory/big-context
 */
router.post('/memory/big-context', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { topics, notes, risks, nextIdeas } = req.body || {};
    const stored = await memoryManager.storeBigContext({
      topics: Array.isArray(topics) ? topics : [],
      source_notes: notes || '',
      risks: Array.isArray(risks) ? risks : [],
      next_ideas: Array.isArray(nextIdeas) ? nextIdeas : [],
      created_by_admin: req.user.id,
      window: 'admin_manual'
    });
    if (!stored) {
      return res.status(500).json({ success: false, message: 'Impossible de stocker le contexte' });
    }
    res.json({ success: true, context: stored });
  } catch (error) {
    logger.error('❌ Erreur ajout big context manuel:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 🗑️ Supprimer un big context
 * DELETE /api/admin/policiercongo/memory/big-context/:id
 */
router.delete('/memory/big-context/:id', authenticateToken, adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const mem = memoryManager.getMemory();
    const current = Array.isArray(mem.bigContexts) ? mem.bigContexts : [];
    const next = current.filter((c) => c.id !== id);
    await memoryManager.update({ bigContexts: next });
    res.json({ success: true, removed: current.length - next.length });
  } catch (error) {
    logger.error('❌ Erreur suppression big context:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 📌 Ajouter une action mémoire manuellement
 * POST /api/admin/policiercongo/memory/action
 */
router.post('/memory/action', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { action, description } = req.body || {};
    if (!action && !description) {
      return res.status(400).json({ success: false, message: 'action/description requis' });
    }
    await memoryManager.addAction({
      action: action || 'ADMIN_NOTE',
      description: description || action,
      source: 'admin'
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Erreur ajout action mémoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 🛰️ Récupère la mémoire V2 (PostgreSQL)
 * GET /api/admin/policiercongo/memory/v2
 */
router.get('/memory/v2', authenticateToken, adminOnly, async (req, res) => {
  try {
    const pool = getPgPool();
    if (!pool) {
      return res.status(500).json({ success: false, message: 'Source de données V2 indisponible' });
    }

    // 1. Vector Nodes (Embeddings)
    const { rows: nodes } = await pool.query(
      `SELECT id, user_id, source_text, metadata, created_at 
       FROM policiercongo_v2_embeddings 
       ORDER BY created_at DESC LIMIT 20`
    );

    // 2. Long-Term Profiles (Insights)
    const { rows: profiles } = await pool.query(
      `SELECT user_id, profile, updated_at 
       FROM policiercongo_v2_user_profile 
       ORDER BY updated_at DESC LIMIT 10`
    );

    // 3. Social Relations
    const { rows: social } = await pool.query(
      `SELECT user_id, data FROM policiercongo_v2_social LIMIT 10`
    );

    // 4. Stats de base
    const { rows: stats } = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM policiercongo_v2_embeddings) as total_nodes,
        (SELECT COUNT(*) FROM policiercongo_v2_user_profile) as total_profiles,
        (SELECT COUNT(*) FROM policiercongo_v2_session) as total_sessions
    `);

    res.json({
      success: true,
      v2Memory: {
        nodes: nodes || [],
        profiles: profiles || [],
        social: social || [],
        stats: stats[0] || {}
      }
    });
  } catch (error) {
    logger.error('❌ Erreur récupération mémoire V2:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * ⏰ Récupère le planning du bot (next_check_in)
 * GET /api/admin/policiercongo/scheduler
 */
router.get('/scheduler', authenticateToken, adminOnly, async (req, res) => {
  try {
    // Recharger l'état partagé : l'horaire vit dans Redis, et cette requête
    // peut très bien être servie par une autre instance que celle qui exécute
    // le cycle.
    await schedulerManager.load();

    const nextRun = schedulerManager.nextRunTime;
    const now = new Date();
    const isReady = await schedulerManager.isTimeForRun();
    
    let minutesUntilRun = null;
    if (nextRun && !isReady) {
      minutesUntilRun = Math.max(0, Math.round((nextRun.getTime() - now.getTime()) / 60000));
    }

    res.json({
      success: true,
      scheduler: {
        next_run_time: nextRun ? nextRun.toISOString() : null,
        is_ready_to_run: isReady,
        minutes_until_run: minutesUntilRun,
        status: isReady ? 'ready' : 'sleeping'
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du scheduler:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * 🔄 Réinitialise le scheduler (force le prochain tour immédiatement)
 * DELETE /api/admin/policiercongo/scheduler
 */
router.delete('/scheduler', authenticateToken, adminOnly, async (req, res) => {
  try {
    logger.info(`🗑️ Tentative de reset du scheduler par l'admin ${req.user.id}`);
    await schedulerManager.reset();
    logger.info(`✅ Scheduler PolicierCongo réinitialisé.`);
    res.json({
      success: true,
      message: 'Scheduler réinitialisé. Le bot sera actif au prochain cycle.'
    });
  } catch (error) {
    logger.error('❌ Erreur lors du reset du scheduler:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route de debug pour attraper les requêtes non matchées sur ce routeur
router.all('/scheduler', (req, res) => {
  logger.warn(`⚠️ Méthode non supportée sur /scheduler: ${req.method}. Path: ${req.path}`);
  res.status(405).json({ success: false, message: `Méthode ${req.method} non supportée sur cette route` });
});

router.all('*', (req, res, next) => {
  logger.info(`🔍 [Router Admin] Route captée mais non gérée par les autres handlers: ${req.method} ${req.path}`);
  next(); // Laisser passer pour le handler global 404
});

module.exports = router;
