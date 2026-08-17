const { validationResult } = require('express-validator');
const { Op, Sequelize } = require('sequelize');
const { sequelize, User, Tweet, Report, ModerationAction, VerificationRequest, UnbanTicket } = require('../models');
const logger = require('../utils/logger');
const ctrTracker = require('../services/ctrTracker');
const reportScoring = require('../services/reportScoringService');
const modNotif = require('../services/moderationNotificationService');
const communityModeration = require('../services/communityModerationService');
const rustClient = require('../services/rustRecommenderClient');
const { strikePolicyForCategory } = require('../config/strikePolicies');
const { REPORT_CATEGORIES, categoriesFor } = require('../config/reportCategories');

class ModerationController {
  // ===== GESTION DES SIGNALEMENTS =====

  // Créer un nouveau signalement
  async createReport(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { target_id, target_type, category, details, source } = req.body;
      const reporter_id = req.user.id;

      const catDef = REPORT_CATEGORIES[category];
      if (!catDef) {
        return res.status(400).json({
          success: false,
          message: 'Catégorie de signalement invalide'
        });
      }
      if (!catDef.targets.includes(target_type)) {
        return res.status(400).json({
          success: false,
          message: `La catégorie « ${catDef.label} » ne s'applique pas à ce type de contenu`
        });
      }
      if (catDef.requiresDetails && !String(details || '').trim()) {
        return res.status(400).json({
          success: false,
          message: 'Merci de préciser le motif du signalement'
        });
      }

      // Quotas : un compte seul ne doit pas pouvoir ensevelir la file.
      const rate = await reportScoring.checkRateLimit(reporter_id);
      if (!rate.allowed) {
        return res.status(429).json({
          success: false,
          message: rate.message,
          retry_after_minutes: rate.retryAfterMin
        });
      }

      // Vérifier que la cible existe, et récupérer son propriétaire pour
      // pouvoir refuser l'auto-signalement.
      let targetExists = false;
      let targetOwnerId = null;
      if (target_type === 'tweet') {
        const tweet = await Tweet.findByPk(target_id, { attributes: ['id', 'user_id'] });
        targetExists = !!tweet;
        targetOwnerId = tweet?.user_id || null;
      } else if (target_type === 'user') {
        const user = await User.findByPk(target_id, { attributes: ['id'] });
        targetExists = !!user;
        targetOwnerId = user?.id || null;
      }

      if (!targetExists) {
        return res.status(404).json({
          success: false,
          message: 'Cible du signalement non trouvée'
        });
      }

      // Auto-signalement : la base en contenait déjà un. Sans intérêt pour la
      // modération, et c'est un moyen simple de polluer ses propres métriques.
      if (targetOwnerId && String(targetOwnerId) === String(reporter_id)) {
        return res.status(400).json({
          success: false,
          message: 'Vous ne pouvez pas signaler votre propre contenu'
        });
      }

      // Doublon : ne bloque que si un signalement du même signaleur sur la
      // même cible est encore ouvert.
      const existingReport = await Report.findOne({
        where: {
          reporter_id,
          target_id,
          target_type,
          status: { [Op.in]: ['pending', 'investigating'] }
        }
      });

      if (existingReport) {
        return res.status(409).json({
          success: false,
          message: 'Vous avez déjà signalé ce contenu, notre équipe l\'examine.',
          data: { report: { id: existingReport.id, status: existingReport.status } }
        });
      }

      // ── Notation ────────────────────────────────────────────────────
      // La gravité n'est plus fournie par le client : elle découle de la
      // catégorie, de la fiabilité du signaleur et de la convergence des
      // signalements sur la même cible.
      const reporterWeight = await reportScoring.getReporterWeight(reporter_id);
      const weightedScore = reportScoring.scoreSingleReport(category, reporterWeight);

      const reportData = {
        reporter_id,
        target_id,
        target_type,
        type: target_type,
        category,
        details: details ? String(details).trim().slice(0, 1000) : null,
        source: source || 'unknown',
        // `reason` reste renseigné : colonne NOT NULL, et les écrans de
        // modération existants l'affichent encore.
        reason: details ? `[${category}] ${String(details).trim().slice(0, 900)}` : `[${category}] ${catDef.label}`,
        reporter_weight: reporterWeight,
        weighted_score: weightedScore,
        severity: catDef.baseSeverity,
        priority: catDef.basePriority,
        status: 'pending'
      };

      const report = await Report.create(reportData);

      // ── Agrégation & escalade ───────────────────────────────────────
      // Se fait APRÈS création pour que le signalement courant compte dans
      // l'agrégat de la cible.
      let escalation = null;
      try {
        const aggregate = await reportScoring.aggregateTarget(target_id, target_type);
        escalation = reportScoring.evaluateEscalation({ category, aggregate });

        await report.update({
          severity: escalation.severity,
          priority: escalation.priority,
          status: escalation.status,
          target_score: aggregate.totalScore,
          auto_escalated: escalation.escalated,
          escalated_at: escalation.escalated ? new Date() : null,
          escalation_reason: escalation.escalationReasons.join(' · ') || null
        });

        // Une cible qui bascule en revue fait basculer TOUS ses signalements
        // ouverts : sinon la file de modération montre le même contenu à deux
        // priorités différentes selon le signalement regardé.
        if (escalation.escalated && aggregate.reportIds.length > 1) {
          await Report.update(
            { status: 'investigating', priority: escalation.priority, target_score: aggregate.totalScore },
            { where: { id: { [Op.in]: aggregate.reportIds }, status: 'pending' } }
          );
        }

        if (escalation.escalated) {
          logger.warn(
            `[report] ESCALADE ${target_type} ${target_id} — ${escalation.escalationReasons.join(' · ')}`
          );
        }
      } catch (scoreError) {
        // Un échec de notation ne doit jamais faire perdre le signalement.
        logger.error(`[report] escalade impossible pour ${report.id}: ${scoreError.message}`);
      }

      // 📊 Track report pour l'algorithme Rust (si c'est un tweet)
      if (target_type === 'tweet') {
        ctrTracker.trackReport(reporter_id, target_id).catch(err => {
          logger.warn(`CTR tracking error: ${err.message}`);
        });

        // Un signalement doit atterrir aux DEUX endroits : la file de
        // modération (ci-dessus) et la revue communautaire. En tâche de fond —
        // la mise en file anonymise via Gemini, et personne ne doit attendre un
        // aller-retour LLM pour voir son signalement accusé réception. Un échec
        // ne coûte rien : le rattrapage par lot (`enqueueReportedTweets`) reste
        // en place derrière.
        communityModeration.enqueueTweet(target_id).catch(err => {
          logger.warn(`[report] mise en revue de ${target_id} impossible: ${err.message}`);
        });
      }

      logger.info(
        `Nouveau signalement ${report.id} [${category}] par ${req.user.username} `
        + `sur ${target_type} ${target_id} (poids ${reporterWeight}, score ${weightedScore})`
      );

      res.status(201).json({
        success: true,
        message: 'Signalement envoyé. Merci, notre équipe va l\'examiner.',
        data: {
          report: {
            id: report.id,
            target_id: report.target_id,
            target_type: report.target_type,
            category: report.category,
            severity: report.severity,
            status: report.status,
            created_at: report.created_at
          },
          // Le client affiche des ressources d'aide pour les catégories de
          // détresse plutôt qu'un simple accusé de réception.
          support_resources: !!catDef.supportResources
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la création du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la création du signalement'
      });
    }
  }

  /**
   * Dossier d'enquête complet sur un signalement.
   *
   * Le panneau de modération n'offrait que trois boutons (résoudre / rejeter /
   * escalader) et, pour toute information, le nom de la cible et un motif en
   * texte libre. Impossible de décider : ni le contenu incriminé, ni
   * l'historique du compte visé, ni les autres signalements sur la même cible.
   *
   * Tout est servi en UN appel — un modérateur qui doit ouvrir cinq écrans
   * pour trancher finit par cliquer au hasard.
   */
  async getReportContext(req, res) {
    try {
      const { reportId } = req.params;

      const report = await Report.findByPk(reportId, {
        include: [
          { model: User, as: 'reporter', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'created_at'] },
          { model: User, as: 'resolver', attributes: ['id', 'username', 'full_name'] }
        ]
      });
      if (!report) {
        return res.status(404).json({ success: false, message: 'Signalement non trouvé' });
      }

      const r = report.toJSON();
      const isTweet = r.target_type === 'tweet';

      // ── Cible + son auteur ────────────────────────────────────────
      let tweet = null;
      let targetUser = null;

      if (isTweet) {
        const t = await Tweet.findByPk(r.target_id, {
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'role',
              'is_suspended', 'suspended_until', 'suspension_reason', 'ban_count',
              'created_at', 'subscription_tier', 'stats']
          }]
        });
        if (t) {
          tweet = t.toJSON();
          targetUser = tweet.author || null;
        }
      } else {
        const u = await User.findByPk(r.target_id, {
          attributes: ['id', 'username', 'full_name', 'avatar', 'bio', 'verified', 'role',
            'is_suspended', 'suspended_until', 'suspension_reason', 'ban_count',
            'created_at', 'last_activity', 'subscription_tier', 'stats', 'email_verified']
        });
        if (u) targetUser = u.toJSON();
      }

      const authorId = targetUser?.id || null;

      // Annotation LLM du tweet : le jugement automatique déjà porté sur ce
      // contenu, que le modérateur avait jusqu'ici aucun moyen de consulter.
      let llm = null;
      if (isTweet && tweet) {
        const [rows] = await sequelize.query(
          `SELECT theme, toxicity_score, toxicity_category, quality_score, quality_class,
                  tone, confidence, model, annotated_at
           FROM tweet_llm_labels WHERE tweet_id = :id LIMIT 1`,
          { replacements: { id: r.target_id } }
        );
        llm = rows?.[0] || null;
      }

      // Engagement réel du tweet — un contenu très diffusé n'a pas le même
      // enjeu qu'un tweet vu par trois personnes.
      let engagement = null;
      if (isTweet && tweet) {
        const [rows] = await sequelize.query(
          `SELECT
             (SELECT count(*) FROM tweet_likes    WHERE tweet_id = :id) AS likes,
             (SELECT count(*) FROM tweet_retweets WHERE tweet_id = :id) AS retweets,
             (SELECT count(*) FROM tweets WHERE parent_tweet_id = :id AND deleted_at IS NULL) AS replies,
             (SELECT count(*) FROM user_behavior_data
               WHERE action_type = 'tweet_view' AND target_type = 'tweet' AND target_id = :idtxt) AS impressions`,
          { replacements: { id: r.target_id, idtxt: String(r.target_id) } }
        );
        engagement = rows?.[0] || null;
      }

      // ── Antécédents du compte visé ────────────────────────────────
      let history = null;
      if (authorId) {
        const [[counts], [byCat], [sanctions], [recent]] = await Promise.all([
          sequelize.query(
            `SELECT
               count(*) FILTER (WHERE target_type = 'user'  AND target_id = :uid) AS on_account,
               count(*) FILTER (WHERE target_type = 'tweet' AND target_id IN
                 (SELECT id FROM tweets WHERE user_id = :uid)) AS on_content,
               count(*) FILTER (WHERE status IN ('pending','investigating')) AS still_open,
               count(*) FILTER (WHERE status = 'resolved'
                 AND resolution_action IS NOT NULL AND resolution_action <> 'none') AS upheld,
               count(*) FILTER (WHERE status = 'dismissed') AS dismissed
             FROM reports
             WHERE (target_type = 'user' AND target_id = :uid)
                OR (target_type = 'tweet' AND target_id IN (SELECT id FROM tweets WHERE user_id = :uid))`,
            { replacements: { uid: authorId } }
          ),
          sequelize.query(
            `SELECT category, count(*) AS n FROM reports
             WHERE ((target_type = 'user' AND target_id = :uid)
                 OR (target_type = 'tweet' AND target_id IN (SELECT id FROM tweets WHERE user_id = :uid)))
               AND category IS NOT NULL
             GROUP BY category ORDER BY n DESC`,
            { replacements: { uid: authorId } }
          ),
          // Sanctions RÉELLEMENT subies : `moderation_actions.type` couvre
          // aussi les validations de contenu ('approve'), qui n'en sont pas.
          sequelize.query(
            `SELECT type, reason, status, created_at, expires_at, reversed_at
             FROM moderation_actions
             WHERE target_type = 'user' AND target_id = :uid
               AND type IN ('ban','suspend','warn','delete')
             ORDER BY created_at DESC LIMIT 20`,
            { replacements: { uid: authorId } }
          ),
          // Publications récentes : sert à voir si l'abus est isolé ou répété.
          sequelize.query(
            `SELECT t.id, left(t.content, 280) AS content, t.created_at, t.moderation_status,
                    l.toxicity_score, l.quality_class, l.theme
             FROM tweets t
             LEFT JOIN tweet_llm_labels l ON l.tweet_id = t.id
             WHERE t.user_id = :uid AND t.deleted_at IS NULL
             ORDER BY t.created_at DESC LIMIT 10`,
            { replacements: { uid: authorId } }
          )
        ]);

        history = {
          reports: counts?.[0] || {},
          by_category: (byCat || []).map((c) => ({
            category: c.category,
            label: REPORT_CATEGORIES[c.category]?.label || c.category,
            count: Number(c.n)
          })),
          sanctions: sanctions || [],
          recent_tweets: recent || []
        };
      }

      // ── Autres signalements sur la même cible ─────────────────────
      const siblings = await Report.findAll({
        where: {
          target_id: r.target_id,
          target_type: r.target_type,
          id: { [Op.ne]: r.id }
        },
        include: [{ model: User, as: 'reporter', attributes: ['id', 'username', 'avatar'] }],
        order: [['created_at', 'DESC']],
        limit: 50
      });

      const aggregate = await reportScoring.aggregateTarget(r.target_id, r.target_type);

      // ── Fiabilité du signaleur ────────────────────────────────────
      const [reporterUpheld, reporterDismissed, reporterTotal] = await Promise.all([
        Report.count({
          where: {
            reporter_id: r.reporter_id,
            status: 'resolved',
            resolution_action: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: 'none' }] }
          }
        }),
        Report.count({ where: { reporter_id: r.reporter_id, status: 'dismissed' } }),
        Report.count({ where: { reporter_id: r.reporter_id } })
      ]);

      res.json({
        success: true,
        data: {
          report: {
            ...r,
            category_label: REPORT_CATEGORIES[r.category]?.label || r.category || 'Signalement'
          },
          reporter: {
            ...(r.reporter || {}),
            // Poids figé au moment du signalement + fiabilité actuelle : un
            // signaleur peut s'être discrédité depuis.
            weight_at_report: r.reporter_weight,
            weight_now: await reportScoring.getReporterWeight(r.reporter_id),
            stats: {
              total: reporterTotal,
              upheld: reporterUpheld,
              dismissed: reporterDismissed
            }
          },
          target: { type: r.target_type, tweet, user: targetUser, llm, engagement },
          history,
          siblings: siblings.map((s) => {
            const sj = s.toJSON();
            return {
              id: sj.id,
              category: sj.category,
              category_label: REPORT_CATEGORIES[sj.category]?.label || sj.category,
              details: sj.details,
              severity: sj.severity,
              status: sj.status,
              weighted_score: sj.weighted_score,
              created_at: sj.created_at,
              reporter: sj.reporter
            };
          }),
          aggregate
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du dossier de signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération du dossier'
      });
    }
  }

  /**
   * Taxonomie des signalements, servie aux clients.
   * Les libellés vivent côté serveur : mobile et Windows n'ont pas à
   * embarquer chacun leur copie qui divergera au premier ajout de catégorie.
   */
  async getReportCategories(req, res) {
    try {
      const targetType = ['tweet', 'user', 'comment'].includes(req.query.target_type)
        ? req.query.target_type
        : 'tweet';
      res.json({
        success: true,
        data: { target_type: targetType, categories: categoriesFor(targetType) }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des catégories:', error);
      res.status(500).json({ success: false, message: 'Erreur lors de la récupération des catégories' });
    }
  }

  /**
   * Signalements envoyés PAR l'utilisateur courant, avec leur statut.
   * Volontairement dépouillé : ni identité du compte visé, ni sanction
   * appliquée — le signaleur n'a pas à savoir ce qui a été infligé à qui.
   */
  async getMyReports(req, res) {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

      const { count, rows } = await Report.findAndCountAll({
        where: { reporter_id: req.user.id },
        attributes: ['id', 'target_type', 'category', 'status', 'created_at', 'resolved_at'],
        order: [['created_at', 'DESC']],
        limit,
        offset: (page - 1) * limit
      });

      res.json({
        success: true,
        data: {
          reports: rows.map((r) => ({
            id: r.id,
            target_type: r.target_type,
            category: r.category,
            category_label: REPORT_CATEGORIES[r.category]?.label || 'Signalement',
            status: r.status,
            created_at: r.created_at,
            resolved_at: r.resolved_at
          })),
          pagination: { page, limit, total: count, pages: Math.ceil(count / limit) }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de mes signalements:', error);
      res.status(500).json({ success: false, message: 'Erreur lors de la récupération des signalements' });
    }
  }

  // Obtenir la liste des signalements
  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, severity, type } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.status = status;
      }

      if (severity && severity !== 'all') {
        where.severity = severity;
      }

      if (type && type !== 'all') {
        where.target_type = type;
      }

      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Enrichir les signalements avec les données de la cible
      const enrichedReports = await Promise.all(reports.map(async (report) => {
        const reportData = report.toJSON();
        
        // Récupérer les données de la cible
        let targetData = null;
        if (report.target_type === 'tweet') {
          const tweet = await Tweet.findByPk(report.target_id, {
            include: [{
              model: User,
              as: 'author',
              attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
            }]
          });
          if (tweet) {
            targetData = {
              id: tweet.id,
              content: tweet.content,
              author: tweet.author,
              created_at: tweet.created_at
            };
          }
        } else if (report.target_type === 'user') {
          const user = await User.findByPk(report.target_id, {
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'role', 'is_suspended']
          });
          if (user) {
            targetData = user.toJSON();
          }
        }

        return {
          ...reportData,
          target: targetData
        };
      }));

      res.json({
        success: true,
        data: {
          reports: enrichedReports,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des signalements'
      });
    }
  }

  // Mettre à jour le statut d'un signalement
  async updateReportStatus(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { reportId } = req.params;
      const { status, moderator_notes, resolution_action, resolution_reason } = req.body;
      const moderator_id = req.user.id;

      const report = await Report.findByPk(reportId);
      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouvé'
        });
      }

      const updateData = {
        status,
        moderator_notes,
        resolved_by: moderator_id,
        resolved_at: new Date()
      };

      if (resolution_action) {
        updateData.resolution_action = resolution_action;
        updateData.resolution_reason = resolution_reason;
      }

      await report.update(updateData);

      logger.info(`Signalement ${reportId} mis à jour par ${req.user.username}: ${status}`);

      res.json({
        success: true,
        message: 'Statut du signalement mis à jour',
        data: {
          report: {
            id: report.id,
            status: report.status,
            moderator_notes: report.moderator_notes,
            resolution_action: report.resolution_action,
            resolved_at: report.resolved_at
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la mise à jour du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour du signalement'
      });
    }
  }

  // ===== GESTION DES UTILISATEURS =====

  // Obtenir la liste des utilisateurs
  async getUsers(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, role, search } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        if (status === 'suspended' || status === 'banned') {
          where.is_suspended = true; // Suspendu = banni
        } else if (status === 'active') {
          where.is_suspended = false;
        }
      }

      if (role && role !== 'all') {
        where.role = role;
      }

      if (search) {
        where[Op.or] = [
          { username: { [Op.iLike]: `%${search}%` } },
          { full_name: { [Op.iLike]: `%${search}%` } }
        ];
      }

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'verified', 'premium',
          'role', 'is_suspended', 'suspended_until', 
          'suspension_reason', 'created_at', 'last_activity'
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Traiter les utilisateurs pour ajouter le statut formaté
      const processedUsers = users.map(user => {
        const userData = user.toJSON();
        
        // Déterminer le statut basé sur is_suspended seulement
        let status = 'active';
        if (userData.is_suspended) {
          status = 'banned';
        }
        
        return {
          ...userData,
          status: status,
          // Ajouter des champs par défaut pour la compatibilité
          followers: 0,
          following: 0,
          tweets: 0,
          reports: 0,
          joinDate: userData.created_at,
          lastSeen: userData.last_activity,
          email: userData.email || ''
        };
      });

      res.json({
        success: true,
        data: {
          users: processedUsers,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des utilisateurs:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des utilisateurs'
      });
    }
  }

  // Obtenir les détails d'un utilisateur
  async getUserDetails(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;

      const user = await User.findByPk(userId, {
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'verified', 'premium',
          'role', 'is_suspended', 'suspended_until', 'suspension_reason',
          'created_at', 'last_activity', 'stats', 'moderation_history'
        ]
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des détails utilisateur:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des détails utilisateur'
      });
    }
  }

  // Suspendre un utilisateur
  async suspendUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason, duration = 7, moderator_note } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Calculer la date de fin de suspension (duration en heures)
      const suspendedUntil = new Date();
      suspendedUntil.setHours(suspendedUntil.getHours() + duration);

      // Mettre à jour l'utilisateur
      await user.update({
        is_suspended: true,
        suspended_at: new Date(),
        suspended_until: suspendedUntil,
        suspension_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'suspend',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        duration: duration, // en heures
        status: 'active',
        expires_at: suspendedUntil,
        metadata: {
          moderator_note,
          original_suspension_reason: user.suspension_reason
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'suspend',
        moderator_id: moderatorId,
        reason,
        duration,
        moderator_note,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur suspendu: ${user.username} par ${req.user.username}`);

      // Prévenir la personne suspendue : sans notification, elle découvre la
      // sanction en butant sur un écran d'erreur, sans motif ni échéance.
      const notified = await modNotif.notifyAccountSuspended(userId, {
        reason,
        until: suspendedUntil,
        durationHours: duration
      });

      res.json({
        success: true,
        message: 'Utilisateur suspendu avec succès',
        data: {
          user: user.getPublicProfile(),
          notified_user: notified,
          suspension_details: {
            reason,
            duration,
            suspended_until: suspendedUntil
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la suspension:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suspension'
      });
    }
  }

  // Lever la suspension d'un utilisateur
  async unsuspendUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (!user.is_suspended) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur n\'est pas suspendu'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve', // Utiliser 'approve' pour lever une suspension
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'reversed',
        reversed_at: new Date(),
        reversed_by: moderatorId,
        reversal_reason: reason,
        metadata: {
          action_type: 'unsuspend',
          original_suspension_reason: user.suspension_reason
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unsuspend',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Suspension levée: ${user.username} par ${req.user.username}`);

      // La bonne nouvelle mérite le même traitement que la sanction : sans
      // message, l'utilisateur ne sait pas qu'il peut de nouveau publier.
      await modNotif.notifySanctionLifted(user.id, { kind: 'suspension' });

      res.json({
        success: true,
        message: 'Suspension levée avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la levée de suspension:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la levée de suspension'
      });
    }
  }

  // Bannir un utilisateur
  async banUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason, duration = 8760, permanent = false, moderator_note } = req.body; // 8760 heures = 1 an par défaut
      const moderatorId = req.user.id;

      logger.info(`Données reçues - userId: ${userId}, reason: ${reason}, duration: ${duration}, permanent: ${permanent}`);
      logger.info(`Body complet:`, req.body);

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Bannissement direct via is_suspended
      const banUntil = permanent ? null : new Date(Date.now() + duration * 60 * 60 * 1000); // duration en heures
      
      logger.info(`Tentative de bannissement - is_suspended: true, reason: ${reason}, banUntil: ${banUntil}`);
      
      const updateData = {
        is_suspended: true, // Bannissement direct
        suspended_at: new Date(),
        suspended_until: banUntil,
        suspension_reason: reason
      };
      
      logger.info(`Données de mise à jour:`, updateData);
      
      await user.update(updateData);
      
      // Recharger l'utilisateur pour avoir les données mises à jour
      await user.reload();
      
      logger.info(`Utilisateur banni avec succès - is_suspended: ${user.is_suspended}`);
      logger.info(`suspended_at: ${user.suspended_at}, suspended_until: ${user.suspended_until}, reason: ${user.suspension_reason}`);

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'ban',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        duration: permanent ? null : duration, // null pour permanent
        status: 'active',
        expires_at: banUntil,
        metadata: {
          permanent,
          moderator_note,
          action_type: 'ban'
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'ban',
        moderator_id: moderatorId,
        reason,
        permanent,
        moderator_note,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur banni: ${user.username} par ${req.user.username}`);

      // Prévenir la personne bannie, avec le motif et la voie de recours
      // (`unban_tickets` existe — le réexamen est un vrai parcours).
      await modNotif.notifyAccountBanned(userId, {
        reason,
        permanent,
        until: banUntil
      });

      res.json({
        success: true,
        message: 'Utilisateur banni avec succès',
        data: {
          user: user.getPublicProfile(),
          ban_details: {
            reason,
            permanent,
            is_suspended: true
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors du bannissement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du bannissement'
      });
    }
  }

  // Débannir un utilisateur
  async unbanUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Mettre à jour l'utilisateur - DÉBANNISSEMENT
      await user.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve', // Utiliser 'approve' pour débannir
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'reversed',
        reversed_at: new Date(),
        reversed_by: moderatorId,
        reversal_reason: reason,
        metadata: {
          action_type: 'unban'
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unban',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur débanni: ${user.username} par ${req.user.username}`);

      await modNotif.notifySanctionLifted(user.id, { kind: 'ban' });

      res.json({
        success: true,
        message: 'Utilisateur débanni avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors du débannissement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du débannissement'
      });
    }
  }

  // Vérifier un utilisateur
  async verifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (user.verified) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur est déjà vérifié'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        verified: true
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          action_type: 'verify',
          original_verified_status: user.verified
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'verify',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur vérifié: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Utilisateur vérifié avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la vérification:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification'
      });
    }
  }

  // Révoquer la vérification d'un utilisateur
  async unverifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (!user.verified) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur n\'est pas vérifié'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        verified: false
      });

      // Supprimer toutes les demandes de vérification de cet utilisateur
      await VerificationRequest.destroy({
        where: { user_id: userId }
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'reject',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          action_type: 'unverify',
          original_verified_status: user.verified
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unverify',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Vérification révoquée: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Vérification révoquée avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la révocation de vérification:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la révocation de vérification'
      });
    }
  }

  // ===== MODÉRATION DE CONTENU =====

  // Obtenir la liste des tweets à modérer
  async getRecentTweetAnnotations(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 50);
      const offset = (page - 1) * limit;
      const annotationStatus = req.query.status || 'all';
      const search = String(req.query.search || '').trim();

      const statusSql = annotationStatus === 'annotated'
        ? 'AND labels.tweet_id IS NOT NULL'
        : annotationStatus === 'pending'
          ? 'AND labels.tweet_id IS NULL'
          : '';
      const searchSql = search
        ? 'AND (tweets.content ILIKE :search OR users.username ILIKE :search)'
        : '';
      const replacements = {
        limit,
        offset,
        ...(search ? { search: `%${search}%` } : {})
      };
      const fromAndWhere = `
        FROM tweets
        INNER JOIN users ON users.id = tweets.user_id
        LEFT JOIN tweet_llm_labels AS labels ON labels.tweet_id = tweets.id
        WHERE tweets.deleted_at IS NULL
          ${statusSql}
          ${searchSql}
      `;

      const [tweets, countRows, summaryRows] = await Promise.all([
        sequelize.query(`
          SELECT
            tweets.id,
            tweets.content,
            tweets.created_at,
            tweets.parent_tweet_id,
            users.id AS author_id,
            users.username AS author_username,
            users.full_name AS author_full_name,
            users.avatar AS author_avatar,
            users.verified AS author_verified,
            labels.theme,
            labels.toxicity_score,
            labels.toxicity_category,
            labels.quality_score,
            labels.quality_class,
            labels.tone,
            labels.confidence,
            labels.model,
            labels.annotated_at
          ${fromAndWhere}
          ORDER BY tweets.created_at DESC
          LIMIT :limit OFFSET :offset
        `, { replacements, type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(`
          SELECT COUNT(*)::integer AS total
          ${fromAndWhere}
        `, { replacements, type: Sequelize.QueryTypes.SELECT }),
        sequelize.query(`
          SELECT
            COUNT(*)::integer AS total,
            COUNT(labels.tweet_id)::integer AS annotated,
            (COUNT(*) - COUNT(labels.tweet_id))::integer AS pending,
            AVG(labels.quality_score)::float AS average_quality,
            AVG(labels.toxicity_score)::float AS average_toxicity,
            AVG(labels.confidence)::float AS average_confidence
          ${fromAndWhere}
        `, { replacements, type: Sequelize.QueryTypes.SELECT })
      ]);

      const total = Number(countRows[0]?.total || 0);
      const summary = summaryRows[0] || {};

      res.json({
        success: true,
        data: {
          tweets: tweets.map(tweet => ({
            id: tweet.id,
            content: tweet.content,
            created_at: tweet.created_at,
            parent_tweet_id: tweet.parent_tweet_id,
            author: {
              id: tweet.author_id,
              username: tweet.author_username,
              full_name: tweet.author_full_name,
              avatar: tweet.author_avatar,
              verified: tweet.author_verified
            },
            annotation: tweet.annotated_at ? {
              theme: tweet.theme,
              toxicity_score: Number(tweet.toxicity_score),
              toxicity_category: tweet.toxicity_category,
              quality_score: Number(tweet.quality_score),
              quality_class: tweet.quality_class,
              tone: tweet.tone,
              confidence: Number(tweet.confidence),
              model: tweet.model,
              annotated_at: tweet.annotated_at
            } : null
          })),
          summary: {
            total: Number(summary.total || 0),
            annotated: Number(summary.annotated || 0),
            pending: Number(summary.pending || 0),
            average_quality: summary.average_quality == null ? null : Number(summary.average_quality),
            average_toxicity: summary.average_toxicity == null ? null : Number(summary.average_toxicity),
            average_confidence: summary.average_confidence == null ? null : Number(summary.average_confidence)
          },
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des annotations des tweets:', error);
      res.status(500).json({
        success: false,
        message: 'Annotations des publications indisponibles'
      });
    }
  }

  async getTweetsForModeration(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, search } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.moderation_status = status;
      }

      if (search) {
        where.content = { [Op.iLike]: `%${search}%` };
      }

      // Ajouter le filtre pour exclure les réponses (parent_tweet_id doit être null)
      where.parent_tweet_id = null;

      const { count, rows: tweets } = await Tweet.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      res.json({
        success: true,
        data: {
          tweets,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tweets:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tweets'
      });
    }
  }

  // Obtenir les détails d'un tweet
  async getTweetDetails(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;

      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'role']
          }
        ]
      });

      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      res.json({
        success: true,
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des détails tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des détails tweet'
      });
    }
  }

  // Approuver un tweet
  async approveTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Mettre à jour le tweet
      await tweet.update({
        moderation_status: 'approved',
        moderation_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          original_moderation_status: tweet.moderation_status
        }
      });

      // Ajouter le tweet au système de recommandation progressive
      try {
        const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
        const recommendationEngine = new ProgressiveRecommendationEngine();
        await recommendationEngine.addNewTweet(tweetId);
        logger.info(`🎯 Tweet ${tweetId} ajouté au système de recommandation progressive (approbation manuelle)`);
      } catch (recError) {
        logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId} au système de recommandation:`, recError);
      }

      logger.info(`Tweet approuvé: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet approuvé avec succès',
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors de l\'approbation du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'approbation du tweet'
      });
    }
  }

  // Rejeter un tweet
  async rejectTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason, severity = 'medium' } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Mettre à jour le tweet
      await tweet.update({
        moderation_status: 'rejected',
        moderation_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'reject',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          severity,
          original_moderation_status: tweet.moderation_status
        }
      });

      logger.info(`Tweet rejeté: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet rejeté avec succès',
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors du rejet du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du rejet du tweet'
      });
    }
  }

  // Supprimer un tweet
  async deleteTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason, notify_user = true } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Créer une entrée dans la table moderation_actions avant la suppression
      await ModerationAction.create({
        type: 'delete',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          notify_user,
          original_tweet_content: (tweet.content || '').substring(0, 100) // Garder un aperçu du contenu
        }
      });

      // Prévenir l'auteur AVANT la suppression : `tweet.content` doit encore
      // être lisible pour recopier l'extrait dans la notification. Sans lui,
      // l'auteur reçoit « une publication a été retirée » sans savoir laquelle.
      let notified = false;
      if (notify_user) {
        notified = await modNotif.notifyContentRemoved(tweet.user_id, {
          tweetId,
          content: tweet.content,
          reason
        });
      }

      // Supprimer le tweet
      await tweet.destroy();

      logger.info(`Tweet supprimé: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet supprimé avec succès',
        data: {
          tweet_id: tweetId,
          reason,
          // Reflète l'envoi RÉEL. Ce champ renvoyait jusqu'ici la valeur
          // demandée par l'appelant alors qu'aucune notification n'existait.
          notified_user: notified
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la suppression du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suppression du tweet'
      });
    }
  }

  // Marquer un tweet comme non éligible aux recommandations
  async markTweetNotEligible(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'mark_not_eligible',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          original_status: tweet.moderation_status,
          original_tweet_content: (tweet.content || '').substring(0, 100)
        }
      });

      // Marquer le tweet comme non éligible
      await tweet.update({
        moderation_status: 'not_eligible',
        moderation_reason: reason
      });

      logger.info(`Tweet marqué comme non éligible: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet marqué comme non éligible aux recommandations',
        data: {
          tweet_id: tweetId,
          reason,
          new_status: 'not_eligible'
        }
      });
    } catch (error) {
      logger.error('Erreur lors du marquage du tweet comme non éligible:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du marquage du tweet comme non éligible'
      });
    }
  }

  // ===== DASHBOARD ET ANALYTICS =====

  // Obtenir le dashboard de modération
  async getModerationDashboard(req, res) {
    try {
      // Statistiques générales
      const totalUsers = await User.count();
      const suspendedUsers = await User.count({ where: { is_suspended: true } });
      const bannedUsers = await User.count({ where: { is_suspended: true } });
      const pendingTweets = await Tweet.count({ where: { moderation_status: 'pending' } });

      // Actions récentes
      const recentActions = await User.findAll({
        where: {
          moderation_history: {
            [Op.not]: null
          }
        },
        attributes: ['id', 'username', 'moderation_history'],
        order: [['updated_at', 'DESC']],
        limit: 10
      });

      res.json({
        success: true,
        data: {
          stats: {
            total_users: totalUsers,
            suspended_users: suspendedUsers,
            banned_users: bannedUsers,
            pending_tweets: pendingTweets
          },
          recent_actions: recentActions
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du dashboard:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération du dashboard'
      });
    }
  }

  // Obtenir les alertes de modération
  async getModerationAlerts(req, res) {
    try {
      const { priority, limit = 10 } = req.query;

      // Simuler des alertes (à implémenter avec un vrai système d'alertes)
      const alerts = [
        {
          id: 1,
          type: 'high_reports',
          priority: 'high',
          message: 'Utilisateur @spam_user a reçu 15 signalements en 24h',
          timestamp: new Date(),
          action_required: true
        },
        {
          id: 2,
          type: 'suspicious_activity',
          priority: 'medium',
          message: 'Activité suspecte détectée sur le compte @bot_account',
          timestamp: new Date(Date.now() - 3600000),
          action_required: false
        }
      ];

      const filteredAlerts = priority 
        ? alerts.filter(alert => alert.priority === priority)
        : alerts;

      res.json({
        success: true,
        data: {
          alerts: filteredAlerts.slice(0, parseInt(limit))
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des alertes:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des alertes'
      });
    }
  }

  // ===== MÉTHODES STUB POUR LES AUTRES ROUTES =====

  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, type, priority } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.status = status;
      }
      
      if (type && type !== 'all') {
        where.type = type;
      }
      
      if (priority) {
        where.priority = parseInt(priority);
      }

      // Récupérer les signalements avec pagination
      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Formater les données pour la compatibilité avec le frontend
      const formattedReports = reports.map(report => {
        const reportData = report.toJSON();
        return {
          id: reportData.id,
          type: reportData.type,
          reporterId: reportData.reporter_id,
          reporterName: reportData.reporter?.full_name || reportData.reporter?.username || 'Utilisateur inconnu',
          targetId: reportData.target_id,
          targetName: `Cible ${reportData.target_type}`,
          reason: reportData.reason,
          severity: reportData.severity,
          status: reportData.status,
          createdAt: reportData.created_at,
          priority: reportData.priority,
          moderatorNotes: reportData.moderator_notes,
          resolvedAt: reportData.resolved_at,
          resolutionAction: reportData.resolution_action,
          resolutionReason: reportData.resolution_reason
        };
      });

      res.json({
        success: true,
        data: {
          reports: formattedReports,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des signalements'
      });
    }
  }

  // NOTE — Deux stubs « à implémenter » de `getReportDetails` et
  // `updateReportStatus` se trouvaient ici. Ils étaient morts : cette classe
  // définit ces méthodes plusieurs fois et, en JavaScript, c'est la DERNIÈRE
  // définition qui l'emporte. Les implémentations réelles sont plus bas dans
  // le fichier. Supprimés pour qu'on cesse de les prendre pour le code actif.

  async getModerationStats(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      // Compter les utilisateurs par statut
      const totalUsers = await User.count();
      const activeUsers = await User.count({ where: { is_suspended: false } });
      const suspendedUsers = await User.count({ where: { is_suspended: true } });
      const bannedUsers = await User.count({ where: { is_suspended: true } });
      const verifiedUsers = await User.count({ where: { verified: true } });
      const premiumUsers = await User.count({ where: { premium: true } });

      // Compter les tweets par statut de modération
      const totalTweets = await Tweet.count();
      const pendingTweets = await Tweet.count({ where: { moderation_status: 'pending' } });
      const approvedTweets = await Tweet.count({ where: { moderation_status: 'approved' } });
      const rejectedTweets = await Tweet.count({ where: { moderation_status: 'rejected' } });
      const notEligibleTweets = await Tweet.count({ where: { moderation_status: 'not_eligible' } });

      // Compter les signalements par statut
      const totalReports = await Report.count();
      const pendingReports = await Report.count({
        where: {
          status: 'pending'
        }
      });
      const investigatingReports = await Report.count({
        where: {
          status: 'investigating'
        }
      });
      const resolvedReports = await Report.count({
        where: {
          status: 'resolved'
        }
      });
      const dismissedReports = await Report.count({
        where: {
          status: 'dismissed'
        }
      });

      // Compter les signalements par type
      const tweetReports = await Report.count({
        where: {
          type: 'tweet'
        }
      });
      const userReports = await Report.count({
        where: {
          type: 'user'
        }
      });

      // Compter les actions de modération
      const moderationActions = await ModerationAction.count();
      const activeActions = await ModerationAction.count({
        where: {
          status: 'active'
        }
      });
      const expiredActions = await ModerationAction.count({
        where: {
          status: 'expired'
        }
      });
      const reversedActions = await ModerationAction.count({
        where: {
          status: 'reversed'
        }
      });

      // Statistiques par type d'action
      const banActions = await ModerationAction.count({
        where: {
          type: 'ban'
        }
      });
      const suspendActions = await ModerationAction.count({
        where: {
          type: 'suspend'
        }
      });
      const deleteActions = await ModerationAction.count({
        where: {
          type: 'delete'
        }
      });
      const approveActions = await ModerationAction.count({
        where: {
          type: 'approve'
        }
      });
      const rejectActions = await ModerationAction.count({
        where: {
          type: 'reject'
        }
      });

      // Statistiques des modérateurs
      const totalModerators = await User.count({
        where: {
          role: {
            [Op.in]: ['moderateur', 'admin', 'superadmin', 'classeurdetweets']
          }
        }
      });

      // Statistiques de performance
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const actionsToday = await ModerationAction.count({
        where: {
          created_at: {
            [Op.gte]: today
          }
        }
      });

      const reportsToday = await Report.count({
        where: {
          created_at: {
            [Op.gte]: today
          }
        }
      });

      // Statistiques des tickets d'unban
      const pendingUnbanTickets = await UnbanTicket.count({
        where: { status: 'pending' }
      });
      const totalUnbanTickets = await UnbanTicket.count();

      const stats = {
        // Statistiques utilisateurs
        users: {
          total: totalUsers,
          active: activeUsers,
          suspended: suspendedUsers,
          banned: bannedUsers,
          verified: verifiedUsers,
          premium: premiumUsers
        },
        // Statistiques tweets
        tweets: {
          total: totalTweets,
          pending: pendingTweets,
          approved: approvedTweets,
          rejected: rejectedTweets,
          not_eligible: notEligibleTweets
        },
        // Statistiques signalements
        reports: {
          total: totalReports,
          pending: pendingReports,
          investigating: investigatingReports,
          resolved: resolvedReports,
          dismissed: dismissedReports,
          byType: {
            tweets: tweetReports,
            users: userReports
          }
        },
        actions: {
          total: moderationActions,
          active: activeActions,
          expired: expiredActions,
          reversed: reversedActions,
          byType: {
            bans: banActions,
            suspensions: suspendActions,
            deletions: deleteActions,
            approvals: approveActions,
            rejections: rejectActions
          }
        },
        // Statistiques modérateurs
        moderators: {
          total: totalModerators
        },
        // Statistiques des tickets d'unban
        unbanTickets: {
          total: totalUnbanTickets,
          pending: pendingUnbanTickets
        },
        // Statistiques de performance
        performance: {
          actionsToday: actionsToday,
          reportsToday: reportsToday
        }
      };

      res.json({
        success: true,
        data: { stats }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des statistiques'
      });
    }
  }

  async getModerationTrends(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { period = '7d' } = req.query;
      
      // Calculer la date de début basée sur la période
      let startDate;
      const now = new Date();
      
      switch (period) {
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }

      // Récupérer les tendances des signalements
      const reportTrends = await Report.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          'status'
        ],
        group: ['DATE(created_at)', 'status'],
        order: [['date', 'ASC']]
      });

      // Récupérer les tendances des actions de modération
      const actionTrends = await ModerationAction.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          'type'
        ],
        group: ['DATE(created_at)', 'type'],
        order: [['date', 'ASC']]
      });

      // Récupérer les tendances des utilisateurs
      const userTrends = await User.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['DATE(created_at)'],
        order: [['date', 'ASC']]
      });

      // Formater les données pour les graphiques
      const trends = {
        reports: reportTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count')),
          status: trend.status
        })),
        actions: actionTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count')),
          type: trend.type
        })),
        users: userTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count'))
        }))
      };

      res.json({
        success: true,
        data: { trends }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tendances:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tendances'
      });
    }
  }

  async getModeratorMetrics(req, res) {
    res.json({
      success: true,
      message: 'Métriques des modérateurs (à implémenter)',
      data: { metrics: [] }
    });
  }

  async getModerationHistory(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, action_type, type, target_type, targetType, status, moderator_id, start_date, end_date } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      const finalType = action_type || type;
      if (finalType && finalType !== 'all') {
        where.type = finalType;
      }
      
      const finalTargetType = target_type || targetType;
      if (finalTargetType && finalTargetType !== 'all') {
        where.target_type = finalTargetType;
      }

      if (moderator_id && moderator_id !== 'all') {
        where.moderator_id = moderator_id;
      }

      if (status && status !== 'all') {
        where.status = status;
      }

      if (start_date || end_date) {
        const { Op } = require('sequelize');
        where.created_at = {};
        if (start_date) where.created_at[Op.gte] = new Date(start_date);
        if (end_date) where.created_at[Op.lte] = new Date(end_date);
      }
      
      if (status && status !== 'all') {
        where.status = status;
      }

      // Récupérer l'historique des actions de modération
      const { count, rows: actions } = await ModerationAction.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'moderator',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Formater les données pour la compatibilité avec le frontend
      const formattedHistory = actions.map(action => {
        const actionData = action.toJSON();
        return {
          id: actionData.id,
          type: actionData.type,
          targetType: actionData.target_type,
          targetId: actionData.target_id,
          targetName: `Cible ${actionData.target_type}`,
          moderatorId: actionData.moderator_id,
          moderatorName: actionData.moderator?.full_name || actionData.moderator?.username || 'Modérateur inconnu',
          reason: actionData.reason,
          duration: actionData.duration,
          createdAt: actionData.created_at,
          status: actionData.status,
          expiresAt: actionData.expires_at,
          reversedAt: actionData.reversed_at,
          reversalReason: actionData.reversal_reason,
          metadata: actionData.metadata
        };
      });

      res.json({
        success: true,
        data: {
          history: formattedHistory,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'historique'
      });
    }
  }


  async getUserModerationHistory(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const { count, rows: actions } = await ModerationAction.findAndCountAll({
        where: {
          target_id: userId,
          target_type: 'user'
        },
        include: [
          {
            model: User,
            as: 'moderator',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      const formattedHistory = actions.map(action => {
        const actionData = action.toJSON();
        return {
          id: actionData.id,
          type: actionData.type,
          targetType: actionData.target_type,
          targetId: actionData.target_id,
          moderatorId: actionData.moderator_id,
          moderatorName: actionData.moderator?.full_name || actionData.moderator?.username || 'Modérateur inconnu',
          reason: actionData.reason,
          duration: actionData.duration,
          createdAt: actionData.created_at,
          status: actionData.status,
          metadata: actionData.metadata
        };
      });

      res.json({
        success: true,
        data: {
          history: formattedHistory,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique utilisateur:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'historique utilisateur'
      });
    }
  }

  async getModerators(req, res) {
    res.json({
      success: true,
      message: 'Liste des modérateurs (à implémenter)',
      data: { moderators: [] }
    });
  }

  async promoteModerator(req, res) {
    res.json({
      success: true,
      message: 'Modérateur promu (à implémenter)'
    });
  }

  async demoteModerator(req, res) {
    res.json({
      success: true,
      message: 'Modérateur rétrogradé (à implémenter)'
    });
  }

  async updateModeratorPermissions(req, res) {
    res.json({
      success: true,
      message: 'Permissions mises à jour (à implémenter)'
    });
  }

  normalizeModerationRole(role) {
    if (role === 'moderator') return 'moderateur';
    if (role === 'super_admin' || role === 'supermoderateur') return 'superadmin';
    return role || 'moderateur';
  }

  async enrichReport(report) {
    const reportData = report.toJSON ? report.toJSON() : report;
    let targetData = null;

    if (reportData.target_type === 'tweet') {
      const tweet = await Tweet.findByPk(reportData.target_id, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
        }]
      });
      if (tweet) {
        targetData = {
          id: tweet.id,
          content: tweet.content,
          author: tweet.author,
          created_at: tweet.created_at
        };
      }
    } else if (reportData.target_type === 'user') {
      const user = await User.findByPk(reportData.target_id, {
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'role', 'is_suspended']
      });
      if (user) targetData = user.toJSON();
    }

    return {
      ...reportData,
      target: targetData,
      reporterId: reportData.reporter_id,
      reporterName: reportData.reporter?.full_name || reportData.reporter?.username || 'Utilisateur inconnu',
      targetId: reportData.target_id,
      targetType: reportData.target_type,
      targetName: targetData?.username || targetData?.author?.username || `Cible ${reportData.target_type}`,
      createdAt: reportData.created_at,
      moderatorNotes: reportData.moderator_notes,
      resolvedAt: reportData.resolved_at,
      resolutionAction: reportData.resolution_action,
      resolutionReason: reportData.resolution_reason
    };
  }

  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Donnees invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, severity, type, priority } = req.query;
      const offset = (page - 1) * limit;
      const where = {};

      if (status && status !== 'all') where.status = status;
      if (severity && severity !== 'all') where.severity = severity;
      if (type && type !== 'all') where.target_type = type;
      if (priority && priority !== 'all') where.priority = parseInt(priority, 10);

      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });

      const enrichedReports = await Promise.all(
        reports.map(report => ModerationController.prototype.enrichReport(report))
      );
      const pagination = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total: count,
        pages: Math.ceil(count / limit)
      };

      res.json({
        success: true,
        data: { reports: enrichedReports, pagination },
        reports: enrichedReports,
        pagination
      });
    } catch (error) {
      logger.error('Erreur lors de la recuperation des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la recuperation des signalements'
      });
    }
  }

  async getReportDetails(req, res) {
    try {
      const { reportId } = req.params;
      const report = await Report.findByPk(reportId, {
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ]
      });

      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouve'
        });
      }

      res.json({
        success: true,
        data: { report: await ModerationController.prototype.enrichReport(report) }
      });
    } catch (error) {
      logger.error('Erreur lors de la recuperation du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la recuperation du signalement'
      });
    }
  }

  async updateReportStatus(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Donnees invalides',
          errors: errors.array()
        });
      }

      const { reportId } = req.params;
      const legacyAction = req.body.action;
      const statusFromAction = legacyAction === 'resolve'
        ? 'resolved'
        : legacyAction === 'dismiss'
          ? 'dismissed'
          : legacyAction === 'escalate'
            ? 'investigating'
            : undefined;
      const status = req.body.status || statusFromAction;
      const moderator_notes = req.body.moderator_notes || req.body.moderator_note || req.body.reason || null;
      const resolution_reason = req.body.resolution_reason || req.body.action_taken || req.body.reason || null;
      const resolution_action = req.body.resolution_action || (status === 'dismissed' ? 'none' : undefined);

      if (!['pending', 'investigating', 'resolved', 'dismissed'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status invalide'
        });
      }

      const report = await Report.findByPk(reportId);
      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouve'
        });
      }

      const updateData = { status };
      if (moderator_notes !== null) updateData.moderator_notes = moderator_notes;
      if (resolution_reason !== null) updateData.resolution_reason = resolution_reason;
      if (resolution_action) updateData.resolution_action = resolution_action;

      if (status === 'resolved' || status === 'dismissed') {
        updateData.resolved_by = req.user.id;
        updateData.resolved_at = new Date();
      } else {
        updateData.resolved_by = null;
        updateData.resolved_at = null;
      }

      await report.update(updateData);
      logger.info(`Signalement ${reportId} traite par ${req.user.username}: ${status}`);

      // L'avertissement n'a pas d'endpoint propre — contrairement à
      // suspend/ban/delete, il n'existe qu'à travers la clôture d'un
      // signalement. On le matérialise ici, sinon « avertir » ne fait
      // strictement rien : ni trace, ni message à l'intéressé.
      //
      // Un signalement RETENU (warn/suspend/ban/delete, jamais 'none') pose
      // en plus un avertissement daté dans le moteur de recommandation, quelle
      // que soit l'action prise sur le contenu : suspendre ou supprimer agit
      // sur CE post, mais ne change rien à la distribution du compte pour ses
      // prochains posts sans ce second effet. C'est ce registre-là (pas
      // l'ancien `algorithmic_visibility_multiplier`) qui pilote le classement
      // réellement servi — voir `rust-recommender/src/shadowban/`.
      if (resolution_action && resolution_action !== 'none') {
        let warnedUserId = null;
        let warnedTweetId = null;

        if (report.target_type === 'tweet') {
          const t = await Tweet.findByPk(report.target_id, { attributes: ['id', 'user_id'] });
          warnedUserId = t?.user_id || null;
          warnedTweetId = t?.id || null;
        } else if (report.target_type === 'user') {
          warnedUserId = report.target_id;
        }

        if (resolution_action === 'warn' && warnedUserId) {
          try {
            await ModerationAction.create({
              type: 'warn',
              target_type: 'user',
              target_id: warnedUserId,
              moderator_id: req.user.id,
              reason: resolution_reason || moderator_notes || 'Avertissement suite à signalement',
              status: 'active',
              metadata: { report_id: report.id, category: report.category }
            });
            await modNotif.notifyWarning(warnedUserId, {
              reason: resolution_reason || moderator_notes || null,
              tweetId: warnedTweetId
            });
          } catch (warnError) {
            // Un avertissement raté ne doit pas empêcher la clôture.
            logger.warn(`[modNotif] avertissement non appliqué (${reportId}): ${warnError.message}`);
          }
        }

        if (warnedUserId) {
          const policy = strikePolicyForCategory(report.category);
          if (policy) {
            try {
              await rustClient.issueStrike(
                warnedUserId,
                policy,
                warnedTweetId,
                resolution_reason || moderator_notes || `Signalement retenu (${report.category})`
              );
            } catch (strikeError) {
              // Le moteur Rust est peut-être indisponible : la clôture du
              // signalement ne doit pas en dépendre, mais la perte doit se voir.
              logger.warn(`[shadowban] avertissement non posé pour le signalement ${reportId}: ${strikeError.message}`);
            }
          }
        }
      }

      // Informer le signaleur du sort de son signalement. Sans ce retour,
      // signaler revient à parler dans le vide — c'est la première raison
      // pour laquelle les gens cessent de le faire.
      if ((status === 'resolved' || status === 'dismissed') && !report.reporter_notified_at) {
        const upheld = status === 'resolved'
          && !!report.resolution_action
          && report.resolution_action !== 'none';
        await reportScoring.notifyReporterOfResolution(report, {
          action: report.resolution_action,
          upheld
        });
        await report.update({ reporter_notified_at: new Date() });
      }

      res.json({
        success: true,
        message: 'Signalement traite avec succes',
        data: { report: await ModerationController.prototype.enrichReport(report) }
      });
    } catch (error) {
      logger.error('Erreur lors de la mise a jour du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise a jour du signalement'
      });
    }
  }

  async promoteModerator(req, res) {
    try {
      const { userId } = req.params;
      const role = ModerationController.prototype.normalizeModerationRole(req.body.role);
      const permissions = req.body.permissions || {};
      const reason = req.body.reason || 'Promotion moderation';

      if (!['moderateur', 'admin', 'superadmin', 'classeurdetweets', 'economiegardien'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Role invalide'
        });
      }

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouve'
        });
      }

      const mergedPermissions = {
        ...(user.moderation_permissions || {}),
        ...permissions
      };

      if (role === 'superadmin') {
        Object.assign(mergedPermissions, {
          can_ban_users: true,
          can_suspend_users: true,
          can_delete_tweets: true,
          can_verify_users: true,
          can_view_reports: true,
          can_view_analytics: true,
          can_manage_moderators: true,
          can_manage_economy: true,
          can_moderate_content: true
        });
      }

      await user.update({
        role,
        moderation_permissions: mergedPermissions
      });

      await ModerationAction.create({
        type: 'approve',
        target_type: 'user',
        target_id: user.id,
        moderator_id: req.user.id,
        reason,
        status: 'active',
        metadata: {
          action_type: 'promote_moderator',
          role,
          permissions: mergedPermissions
        }
      });

      res.json({
        success: true,
        message: 'Moderateur promu avec succes',
        data: {
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            moderation_permissions: user.moderation_permissions
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la promotion moderation:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la promotion moderation'
      });
    }
  }

  async getModerationConfig(req, res) {
    res.json({
      success: true,
      message: 'Configuration de modération (à implémenter)',
      data: { config: {} }
    });
  }



  async updateModerationConfig(req, res) {
    res.json({
      success: true,
      message: 'Configuration mise à jour (à implémenter)'
    });
  }
  // ===== GESTION DES TICKETS D'UNBAN =====
  
  // Créer un ticket d'unban
  async createUnbanTicket(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { reason } = req.body;
      const user_id = req.user.id;
      const user = await User.findByPk(user_id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Seuls les utilisateurs suspendus peuvent faire un ticket (sauf exception policiercongo mentionnée par l'utilisateur)
      if (!user.is_suspended && user.username !== 'policiercongo') {
        return res.status(400).json({
          success: false,
          message: 'Votre compte n\'est pas suspendu'
        });
      }

      // Vérifier s'il y a déjà un ticket en attente
      const existingTicket = await UnbanTicket.findOne({
        where: {
          user_id,
          status: 'pending'
        }
      });

      if (existingTicket) {
        return res.status(400).json({
          success: false,
          message: 'Vous avez déjà un ticket d\'unban en attente de traitement'
        });
      }

      // Création du ticket
      // Pas de limite de char pour policiercongo comme demandé
      const ticket = await UnbanTicket.create({
        user_id,
        reason,
        status: 'pending'
      });

      logger.info(`Nouveau ticket d'unban créé: ${ticket.id} par ${user.username}`);

      res.status(201).json({
        success: true,
        message: 'Votre demande d\'unban a été envoyée avec succès',
        data: { ticket }
      });
    } catch (error) {
      logger.error('Erreur lors de la création du ticket d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'envoi de la demande d\'unban'
      });
    }
  }

  // Obtenir tous les tickets d'unban (Admins)
  async getUnbanTickets(req, res) {
    try {
      const { status = 'pending', page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const where = {};
      if (status !== 'all') {
        where.status = status;
      }

      const { count, rows: tickets } = await UnbanTicket.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'full_name', 'avatar', 'is_suspended', 'suspension_reason']
          },
          {
            model: User,
            as: 'processor',
            attributes: ['id', 'username']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      res.json({
        success: true,
        data: {
          tickets,
          pagination: {
            total: count,
            page: parseInt(page),
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tickets d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tickets d\'unban'
      });
    }
  }

  // Traiter un ticket d'unban
  async processUnbanTicket(req, res) {
    try {
      const { ticketId } = req.params;
      const { status, admin_notes } = req.body; // 'approved' ou 'rejected'
      const admin_id = req.user.id;

      const ticket = await UnbanTicket.findByPk(ticketId, {
        include: [{ model: User, as: 'user' }]
      });

      if (!ticket) {
        return res.status(404).json({
          success: false,
          message: 'Ticket non trouvé'
        });
      }

      if (ticket.status !== 'pending') {
        return res.status(400).json({
          success: false,
          message: 'Ce ticket a déjà été traité'
        });
      }

      // Mise à jour du ticket
      await ticket.update({
        status,
        admin_notes,
        processed_by: admin_id,
        processed_at: new Date()
      });

      // Si approuvé, on débannit l'utilisateur
      if (status === 'approved') {
        const user = ticket.user;
        if (user) {
          await user.update({
            is_suspended: false,
            suspended_at: null,
            suspended_until: null,
            suspension_reason: null
          });
          
          // Log de l'action de modération
          await ModerationAction.create({
            type: 'approve',
            target_type: 'user',
            target_id: user.id,
            moderator_id: admin_id,
            reason: 'Unban ticket approved: ' + admin_notes,
            status: 'reversed'
          });

          logger.info(`Utilisateur ${user.username} débanni via ticket d'unban`);
        }
      }

      res.json({
        success: true,
        message: `Ticket ${status === 'approved' ? 'approuvé' : 'rejeté'} avec succès`,
        data: { ticket }
      });
    } catch (error) {
      logger.error('Erreur lors du traitement du ticket d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du traitement du ticket d\'unban'
      });
    }
  }
}

module.exports = new ModerationController();
