/**
 * 📋 Routes pour les demandes de vérification
 * Gère les demandes de vérification des utilisateurs
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = authMiddleware;
const { User, VerificationRequest } = require('../models');
const VerificationService = require('../services/verificationService');

// Middleware de validation
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

// Initialiser le service de vérification
let verificationService;
const initializeVerificationService = async () => {
  if (!verificationService) {
    verificationService = new VerificationService();
  }
  return verificationService;
};

/**
 * POST /api/verification/request
 * Créer une demande de vérification
 */
router.post('/request', [
  authMiddleware.authenticateToken,
  body('request_type').isIn(['individual', 'brand', 'organization', 'celebrity']).withMessage('Type de demande invalide'),
  body('public_impact').isLength({ min: 8, max: 400 }).withMessage('Impact public doit contenir entre 8 et 400 caractères'),
  body('platform_impact').isLength({ min: 8, max: 300 }).withMessage('Impact plateforme doit contenir entre 8 et 300 caractères'),
  body('public_identification').isLength({ min: 8, max: 300 }).withMessage('Identification publique doit contenir entre 8 et 300 caractères'),
  body('notable_achievements').optional().isLength({ max: 300 }).withMessage('Réalisations trop longues'),
  body('profession').optional().isLength({ max: 100 }).withMessage('Profession trop longue'),
  body('organization').optional().isLength({ max: 100 }).withMessage('Nom d\'organisation trop long'),
  handleValidationErrors
], async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Vérifier si l'utilisateur est déjà vérifié
    const user = await User.findByPk(userId);
    if (user.verified) {
      return res.status(400).json({
        success: false,
        message: 'Vous êtes déjà vérifié'
      });
    }

    // Vérifier s'il y a déjà une demande en cours
    const existingRequest = await VerificationRequest.findOne({
      where: { 
        user_id: userId,
        status: ['pending', 'under_review']
      }
    });

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà une demande de vérification en cours'
      });
    }

    // Créer la demande de vérification
    const formData = {
      request_type: req.body.request_type,
      public_impact: req.body.public_impact,
      platform_impact: req.body.platform_impact,
      public_identification: req.body.public_identification,
      notable_achievements: req.body.notable_achievements,
      profession: req.body.profession,
      organization: req.body.organization,
      submitted_at: new Date().toISOString()
    };

    const verificationRequest = await VerificationRequest.createVerificationRequest(
      userId,
      formData,
      req.body.request_type
    );

    // Traiter automatiquement avec Gemini en arrière-plan (asynchrone)
    const service = await initializeVerificationService();
    
    // Lancer le traitement en arrière-plan sans attendre
    service.processVerificationRequest(verificationRequest.id)
      .then(result => {
        logger.info(`✅ Demande de vérification traitée: ${verificationRequest.id}`, result);
      })
      .catch(error => {
        logger.error(`❌ Erreur lors du traitement de la demande ${verificationRequest.id}:`, error);
      });

    logger.info(`📋 Demande de vérification créée: ${verificationRequest.id} pour ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Demande de vérification soumise avec succès',
      data: {
        request_id: verificationRequest.id,
        status: verificationRequest.status,
        message: 'Votre demande est en cours de traitement. Vous recevrez une notification une fois l\'analyse terminée.',
        estimated_review_time: 'Quelques minutes'
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la création de la demande de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/status
 * Obtenir le statut de la demande de vérification de l'utilisateur
 */
router.get('/status', [
  authMiddleware.authenticateToken
], async (req, res) => {
  try {
    const userId = req.user.id;

    const verificationRequest = await VerificationRequest.findOne({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      include: [
        { model: User, as: 'user', attributes: ['id', 'username', 'verified', 'verification_style'] }
      ]
    });

    if (!verificationRequest) {
      return res.json({
        success: true,
        data: {
          has_request: false,
          status: null,
          can_request: true
        }
      });
    }

    res.json({
      success: true,
      data: {
        has_request: true,
        request_id: verificationRequest.id,
        status: verificationRequest.status,
        request_type: verificationRequest.request_type,
        submitted_at: verificationRequest.created_at,
        processed_at: verificationRequest.processed_at,
        reason: verificationRequest.reason,
        can_request: !['pending', 'under_review'].includes(verificationRequest.status),
        gemini_analysis: verificationRequest.gemini_response ? {
          recommendation: verificationRequest.gemini_response.parsed_analysis?.recommendation,
          confidence: verificationRequest.gemini_response.parsed_analysis?.confidence,
          reasoning: verificationRequest.gemini_response.parsed_analysis?.reasoning
        } : null
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du statut de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/request/:id
 * Obtenir le statut d'une demande de vérification spécifique (pour l'utilisateur propriétaire)
 */
router.get('/request/:id', [
  authMiddleware.authenticateToken,
  param('id').isUUID().withMessage('ID de demande invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const verificationRequest = await VerificationRequest.findByPk(id, {
      include: [
        { 
          model: User, 
          as: 'user', 
          attributes: ['id', 'username', 'verified', 'verification_style'] 
        }
      ]
    });

    if (!verificationRequest) {
      return res.status(404).json({
        success: false,
        message: 'Demande de vérification non trouvée'
      });
    }

    // Vérifier que l'utilisateur est le propriétaire de la demande
    if (verificationRequest.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à cette demande'
      });
    }

    res.json({
      success: true,
      data: {
        id: verificationRequest.id,
        status: verificationRequest.status,
        request_type: verificationRequest.request_type,
        form_data: verificationRequest.form_data,
        analysis_data: verificationRequest.analysis_data,
        reason: verificationRequest.reason,
        processed_at: verificationRequest.processed_at,
        created_at: verificationRequest.created_at,
        updated_at: verificationRequest.updated_at
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération de la demande de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/requirements
 * Obtenir les critères de vérification
 */
router.get('/requirements', async (req, res) => {
  try {
    const requirements = {
      individual: {
        title: 'Vérification Individuelle',
        description: 'Pour les comptes authentiques qui ont une vraie présence',
        questions: [
          'Qui etes-vous sur twitninf en une phrase ?',
          'Pourquoi votre compte doit etre verifie ?',
          'Comment les gens peuvent confirmer que ce compte est bien vous ?',
          'Quelle est votre activite principale (optionnel) ?'
        ],
        criteria: [
          'Compte actif et authentique',
          'Présentation crédible et cohérente',
          'Risque raisonnable d\'usurpation'
        ],
        documents_required: [
          'Aucune pièce obligatoire, mais des infos claires'
        ]
      },
      brand: {
        title: 'Vérification Marque',
        description: 'Pour les marques présentes et actives sur la plateforme',
        questions: [
          'Quel est le nom de votre marque sur twitninf ?',
          'Pourquoi cette marque doit etre verifiee ?',
          'Comment prouver que ce compte est le compte officiel ?',
          'Nom de l\'entreprise ou structure (optionnel)'
        ],
        criteria: [
          'Marque identifiable',
          'Activité régulière et cohérente',
          'Risque de faux compte'
        ],
        documents_required: [
          'Aucune pièce obligatoire, mais des infos vérifiables'
        ]
      },
      organization: {
        title: 'Vérification Organisation',
        description: 'Pour les associations, institutions et collectifs officiels',
        questions: [
          'Quelle organisation represente ce compte ?',
          'Pourquoi cette organisation doit etre verifiee ?',
          'Comment verifier que ce compte est officiel ?',
          'Role ou fonction dans l\'organisation (optionnel)'
        ],
        criteria: [
          'Organisation identifiable',
          'Mission claire',
          'Compte officiel crédible'
        ],
        documents_required: [
          'Aucune pièce obligatoire, mais des infos vérifiables'
        ]
      },
      celebrity: {
        title: 'Vérification Célébrité',
        description: 'Pour les personnalités reconnues ou exposées',
        questions: [
          'Dans quel domaine etes-vous connu ?',
          'Pourquoi votre compte doit etre verifie sur twitninf ?',
          'Comment les utilisateurs peuvent reconnaitre votre compte officiel ?',
          'Realisations notables (optionnel)'
        ],
        criteria: [
          'Notoriété identifiable',
          'Présence publique cohérente',
          'Risque élevé d\'usurpation'
        ],
        documents_required: [
          'Aucune pièce obligatoire, mais des infos vérifiables'
        ]
      }
    };

    res.json({
      success: true,
      data: requirements
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des critères:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/stats
 * Obtenir les statistiques des demandes de vérification (Admin)
 */
router.get('/stats', [
  authMiddleware.authenticateToken,
  authMiddleware.requireAdmin
], async (req, res) => {
  try {
    const service = await initializeVerificationService();
    const stats = await service.getVerificationStats();

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des stats de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/requests
 * Obtenir la liste des demandes de vérification (Admin)
 */
router.get('/requests', [
  authMiddleware.authenticateToken,
  authMiddleware.requireAdmin,
  query('status').optional().isIn(['pending', 'approved', 'rejected', 'under_review']).withMessage('Statut invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limite invalide'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      status = null,
      limit = 20,
      offset = 0
    } = req.query;

    const whereClause = {};
    if (status) {
      whereClause.status = status;
    }

    const verificationRequests = await VerificationRequest.findAndCountAll({
      where: whereClause,
      include: [
        { 
          model: User, 
          as: 'user', 
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'created_at'] 
        },
        { 
          model: User, 
          as: 'processor', 
          attributes: ['id', 'username'], 
          required: false 
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      data: {
        requests: verificationRequests.rows,
        pagination: {
          total: verificationRequests.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: (parseInt(offset) + parseInt(limit)) < verificationRequests.count
        }
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des demandes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * PUT /api/verification/requests/:id/approve
 * Approuver une demande de vérification (Admin)
 */
router.put('/requests/:id/approve', [
  authMiddleware.authenticateToken,
  authMiddleware.requireAdmin,
  param('id').isUUID().withMessage('ID de demande invalide'),
  body('reason').optional().isLength({ max: 500 }).withMessage('Raison trop longue'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const { reason } = req.body;

    const verificationRequest = await VerificationRequest.findByPk(id, {
      include: [{ model: User, as: 'user' }]
    });

    if (!verificationRequest) {
      return res.status(404).json({
        success: false,
        message: 'Demande de vérification non trouvée'
      });
    }

    await verificationRequest.approve(adminId, reason);

    logger.info(`✅ Demande de vérification ${id} approuvée par ${adminId}`);

    res.json({
      success: true,
      message: 'Demande de vérification approuvée avec succès'
    });

  } catch (error) {
    logger.error('❌ Erreur lors de l\'approbation de la demande:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * PUT /api/verification/requests/:id/reject
 * Rejeter une demande de vérification (Admin)
 */
router.put('/requests/:id/reject', [
  authMiddleware.authenticateToken,
  authMiddleware.requireAdmin,
  param('id').isUUID().withMessage('ID de demande invalide'),
  body('reason').isLength({ min: 5, max: 500 }).withMessage('Raison doit contenir entre 5 et 500 caractères'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;
    const { reason } = req.body;

    const verificationRequest = await VerificationRequest.findByPk(id, {
      include: [{ model: User, as: 'user' }]
    });

    if (!verificationRequest) {
      return res.status(404).json({
        success: false,
        message: 'Demande de vérification non trouvée'
      });
    }

    await verificationRequest.reject(adminId, reason);

    logger.info(`❌ Demande de vérification ${id} rejetée par ${adminId}`);

    res.json({
      success: true,
      message: 'Demande de vérification rejetée'
    });

  } catch (error) {
    logger.error('❌ Erreur lors du rejet de la demande:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/verification/requests/:id
 * Obtenir les détails d'une demande de vérification (Admin)
 */
router.get('/requests/:id', [
  authMiddleware.authenticateToken,
  authMiddleware.requireAdmin,
  param('id').isUUID().withMessage('ID de demande invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;

    const verificationRequest = await VerificationRequest.findByPk(id, {
      include: [
        { 
          model: User, 
          as: 'user', 
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'created_at', 'stats'] 
        },
        { 
          model: User, 
          as: 'processor', 
          attributes: ['id', 'username'], 
          required: false 
        }
      ]
    });

    if (!verificationRequest) {
      return res.status(404).json({
        success: false,
        message: 'Demande de vérification non trouvée'
      });
    }

    // Analyser la qualité du contenu si pas déjà fait
    let contentQuality = null;
    if (!verificationRequest.analysis_data?.content_quality) {
      const service = await initializeVerificationService();
      contentQuality = await service.analyzeContentQuality(verificationRequest.user_id);
    }

    res.json({
      success: true,
      data: {
        ...verificationRequest.toJSON(),
        content_quality: contentQuality || verificationRequest.analysis_data?.content_quality
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des détails:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

module.exports = router;
