'use strict';

/**
 * Contrôleur des drapeaux de fonctionnalité.
 *
 * Deux publics, deux surfaces :
 *   - le CLIENT ne voit que des décisions (`{ enabled, variant, payload }`),
 *     jamais les règles. Envoyer les règles reviendrait à publier la liste
 *     des testeurs internes et la composition des cohortes ;
 *   - l'ADMIN voit et modifie les définitions complètes.
 */

const { Op } = require('sequelize');
const { FeatureFlag, User } = require('../models');
const logger = require('../utils/logger');
const featureFlags = require('../services/featureFlagService');
const evaluator = require('../services/featureFlagEvaluator');
const autoRollout = require('../services/featureFlagAutoRollout');

const KEY_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

/** Normalise et valide un segment de ciblage venu du client d'administration. */
function sanitizeRule(rule, index) {
  if (!rule || typeof rule !== 'object') {
    throw new Error(`Segment #${index + 1} invalide`);
  }

  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const cleanConditions = conditions.map((condition, position) => {
    if (!condition || !condition.attribute) {
      throw new Error(`Condition #${position + 1} du segment #${index + 1} : attribut manquant`);
    }
    if (!Object.prototype.hasOwnProperty.call(evaluator.ATTRIBUTES, condition.attribute)) {
      throw new Error(`Attribut inconnu : ${condition.attribute}`);
    }
    if (!evaluator.OPERATORS.includes(condition.operator)) {
      throw new Error(`Opérateur inconnu : ${condition.operator}`);
    }
    return {
      attribute: condition.attribute,
      operator: condition.operator,
      value: condition.value ?? null,
    };
  });

  const percentage = rule.percentage === undefined || rule.percentage === null
    ? 100
    : Number(rule.percentage);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error(`Segment #${index + 1} : pourcentage hors bornes`);
  }

  return {
    id: rule.id || `seg_${index + 1}`,
    label: rule.label || null,
    percentage: Math.round(percentage),
    variant: rule.variant || null,
    conditions: cleanConditions,
  };
}

function sanitizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants
    .filter((variant) => variant && variant.key)
    .map((variant) => ({
      key: String(variant.key),
      weight: Number(variant.weight) > 0 ? Number(variant.weight) : 1,
      payload: variant.payload ?? null,
    }));
}

function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}

/** Champs modifiables, avec leur nettoyage. Tout le reste est ignoré. */
function buildWritablePayload(body) {
  const payload = {};

  if (body.name !== undefined) payload.name = String(body.name).trim();
  if (body.description !== undefined) payload.description = body.description || null;
  if (body.enabled !== undefined) payload.enabled = Boolean(body.enabled);

  if (body.rollout_percentage !== undefined) {
    const value = Number(body.rollout_percentage);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error('Le palier de déploiement doit être compris entre 0 et 100');
    }
    payload.rollout_percentage = Math.round(value);
  }

  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules)) throw new Error('`rules` doit être une liste de segments');
    payload.rules = body.rules.map(sanitizeRule);
  }

  if (body.variants !== undefined) payload.variants = sanitizeVariants(body.variants);
  if (body.allowlist !== undefined) payload.allowlist = sanitizeList(body.allowlist);
  if (body.blocklist !== undefined) payload.blocklist = sanitizeList(body.blocklist);

  if (body.bucket_by !== undefined) {
    if (!FeatureFlag.BUCKET_UNITS.includes(body.bucket_by)) {
      throw new Error(`Unité de tirage inconnue : ${body.bucket_by}`);
    }
    payload.bucket_by = body.bucket_by;
  }

  if (body.salt !== undefined) payload.salt = String(body.salt).slice(0, 32) || 'v1';
  if (body.payload !== undefined) payload.payload = body.payload ?? null;
  if (body.start_at !== undefined) payload.start_at = body.start_at || null;
  if (body.end_at !== undefined) payload.end_at = body.end_at || null;

  return payload;
}

const creatorInclude = [
  { model: User, as: 'creator', attributes: ['id', 'username'], required: false },
  { model: User, as: 'updater', attributes: ['id', 'username'], required: false },
];

module.exports = {
  // ───────────────────────── Côté client ─────────────────────────

  /**
   * GET /api/feature-flags/resolve
   * Tous les drapeaux résolus pour l'appelant, en un appel. L'app le fait au
   * démarrage puis met en cache : tester un drapeau à l'écran ne déclenche
   * ensuite aucun réseau.
   */
  async resolve(req, res) {
    try {
      const context = await featureFlags.contextFromRequest(req);
      const { flags } = await featureFlags.resolveAll(context);

      return res.json({
        success: true,
        data: {
          flags,
          // Horodatage du calcul : l'app s'en sert pour dater son cache et
          // décider s'il faut redemander.
          resolved_at: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(`[featureFlags] resolve: ${error.message}`);
      // Jamais d'erreur au client : un échec ici doit rendre « tout éteint »,
      // pas casser le démarrage de l'application.
      return res.json({ success: true, data: { flags: {}, resolved_at: new Date().toISOString() } });
    }
  },

  /** GET /api/feature-flags/resolve/:key — décision pour un seul drapeau. */
  async resolveOne(req, res) {
    try {
      const context = await featureFlags.contextFromRequest(req);
      const definitions = await featureFlags.getDefinitions();
      const full = await featureFlags.resolveLazyAttributes(context, {
        [req.params.key]: definitions[req.params.key] || {},
      });
      const decision = evaluator.evaluate(definitions[req.params.key], full);

      return res.json({
        success: true,
        data: {
          key: req.params.key,
          enabled: decision.enabled,
          variant: decision.variant,
          payload: decision.payload,
        },
      });
    } catch (error) {
      logger.error(`[featureFlags] resolveOne: ${error.message}`);
      return res.json({
        success: true,
        data: { key: req.params.key, enabled: false, variant: null, payload: null },
      });
    }
  },

  // ───────────────────────── Côté admin ─────────────────────────

  /** GET /api/feature-flags/admin — liste complète, archivés sur demande. */
  async list(req, res) {
    try {
      const includeArchived = req.query.include_archived === 'true';
      const flags = await FeatureFlag.findAll({
        where: includeArchived ? {} : { archived_at: null },
        include: creatorInclude,
        order: [
          ['archived_at', 'ASC'],
          ['enabled', 'DESC'],
          ['key', 'ASC'],
        ],
      });

      return res.json({
        success: true,
        data: {
          flags,
          // Le vocabulaire de ciblage vient du serveur : l'écran
          // d'administration n'a pas à dupliquer la liste des attributs et
          // opérateurs, qui deviendrait fausse à la première évolution.
          schema: {
            attributes: evaluator.ATTRIBUTES,
            operators: evaluator.OPERATORS,
            bucket_units: FeatureFlag.BUCKET_UNITS,
            auto_rollout: {
              default_steps: autoRollout.DEFAULT_STEPS,
              default_interval_minutes: autoRollout.DEFAULT_INTERVAL_MINUTES,
              min_interval_minutes: autoRollout.MIN_INTERVAL_MINUTES,
              max_interval_minutes: autoRollout.MAX_INTERVAL_MINUTES,
              halt_reasons: autoRollout.HALT_REASONS,
            },
          },
          cache: featureFlags.getStats(),
        },
      });
    } catch (error) {
      logger.error(`[featureFlags] list: ${error.message}`);
      return fail(res, 500, 'Impossible de charger les drapeaux');
    }
  },

  /** GET /api/feature-flags/admin/:key */
  async getOne(req, res) {
    try {
      const flag = await FeatureFlag.findOne({
        where: { key: req.params.key },
        include: creatorInclude,
      });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');
      return res.json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] getOne: ${error.message}`);
      return fail(res, 500, 'Impossible de charger le drapeau');
    }
  },

  /** POST /api/feature-flags/admin */
  async create(req, res) {
    try {
      const key = String(req.body.key || '').trim().toLowerCase();
      if (!KEY_PATTERN.test(key)) {
        return fail(res, 400, 'Clé invalide : minuscules, chiffres et . _ - uniquement (ex: feed.new_ranker)');
      }

      const existing = await FeatureFlag.findOne({ where: { key } });
      if (existing) return fail(res, 409, 'Cette clé existe déjà');

      const payload = buildWritablePayload(req.body);
      if (!payload.name) return fail(res, 400, 'Le nom est obligatoire');

      const flag = await FeatureFlag.create({
        ...payload,
        key,
        created_by: req.user?.id || null,
        updated_by: req.user?.id || null,
      });

      await featureFlags.invalidate();
      logger.info(`[featureFlags] création "${key}" par ${req.user?.username || req.user?.id}`);
      return res.status(201).json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] create: ${error.message}`);
      return fail(res, 400, error.message);
    }
  },

  /** PUT /api/feature-flags/admin/:key */
  async update(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      const payload = buildWritablePayload(req.body);

      // Une montée automatique en cours s'arrête dès qu'un humain touche au
      // palier : sans ça, l'automatisme remonterait à l'intervalle suivant ce
      // qu'on vient de redescendre.
      const before = autoRollout.effectiveStep(flag);
      const after = autoRollout.effectiveStep({ ...flag.get({ plain: true }), ...payload });
      const halt = before === after ? {} : autoRollout.haltFieldsOnManualChange(flag);

      await flag.update({ ...payload, ...halt, updated_by: req.user?.id || null });

      await featureFlags.invalidate();
      logger.info(`[featureFlags] mise à jour "${flag.key}" par ${req.user?.username || req.user?.id}`);
      return res.json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] update: ${error.message}`);
      return fail(res, 400, error.message);
    }
  },

  /**
   * PATCH /api/feature-flags/admin/:key/rollout
   * Le geste le plus fréquent — monter d'un palier — a sa propre route :
   * l'écran mobile n'a pas à renvoyer toute la définition pour changer un
   * nombre, et le risque d'écraser un segment par mégarde disparaît.
   */
  async setRollout(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      const value = Number(req.body.rollout_percentage);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return fail(res, 400, 'Le palier doit être compris entre 0 et 100');
      }

      const previous = flag.rollout_percentage;
      const halt = previous === Math.round(value) ? {} : autoRollout.haltFieldsOnManualChange(flag);

      await flag.update({
        rollout_percentage: Math.round(value),
        enabled: req.body.enabled === undefined ? flag.enabled : Boolean(req.body.enabled),
        ...halt,
        updated_by: req.user?.id || null,
      });

      await featureFlags.invalidate();
      logger.info(
        `[featureFlags] palier "${flag.key}" ${previous}% → ${flag.rollout_percentage}% par ${req.user?.username || req.user?.id}`
      );
      return res.json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] setRollout: ${error.message}`);
      return fail(res, 500, 'Impossible de changer le palier');
    }
  },

  /**
   * POST /api/feature-flags/admin/:key/auto-rollout
   * Arme ou désarme la montée automatique du palier.
   *
   *   { enabled: true, steps: [5,25,100], interval_minutes: 1440 }  → armer
   *   { enabled: false }                                            → désarmer
   *
   * Armer ne fait pas monter tout de suite : le premier cran tombe au bout
   * d'un intervalle. L'intervalle sert à observer le palier courant, y compris
   * celui depuis lequel on arme — avancer immédiatement le sauterait.
   */
  async setAutoRollout(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      if (req.body.enabled === false) {
        await autoRollout.disarm(flag, req.user?.id || null);
        await featureFlags.invalidate();
        return res.json({ success: true, data: flag });
      }

      if (flag.archived_at) return fail(res, 400, 'Drapeau archivé : rien à faire monter');

      const plan = await autoRollout.arm(
        flag,
        {
          steps: req.body.steps,
          interval_minutes: req.body.interval_minutes,
          actorId: req.user?.id || null,
        }
      );

      await featureFlags.invalidate();
      logger.info(
        `[featureFlags] montée "${flag.key}" armée par ${req.user?.username || req.user?.id}`
      );
      return res.json({
        success: true,
        data: flag,
        meta: { summary: autoRollout.describe(plan, autoRollout.effectiveStep(flag)) },
      });
    } catch (error) {
      logger.error(`[featureFlags] setAutoRollout: ${error.message}`);
      return fail(res, 400, error.message);
    }
  },

  /**
   * POST /api/feature-flags/admin/:key/kill
   * Coupe-circuit : éteint pour tout le monde sans toucher au ciblage, pour
   * pouvoir rallumer exactement la même configuration une fois le problème
   * corrigé.
   */
  async kill(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      // Le coupe-circuit arrête aussi la montée : on éteint parce que quelque
      // chose ne va pas, la portée ne doit pas continuer à s'élargir.
      await flag.update({
        enabled: false,
        ...autoRollout.haltFieldsOnManualChange(flag, 'flag_off'),
        updated_by: req.user?.id || null,
      });
      await featureFlags.invalidate();
      logger.warn(`[featureFlags] COUPE-CIRCUIT "${flag.key}" par ${req.user?.username || req.user?.id}`);
      return res.json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] kill: ${error.message}`);
      return fail(res, 500, 'Impossible de couper le drapeau');
    }
  },

  /** POST /api/feature-flags/admin/:key/archive — et `?restore=true` pour annuler. */
  async archive(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      const restore = req.body.restore === true;
      await flag.update({
        archived_at: restore ? null : new Date(),
        enabled: restore ? flag.enabled : false,
        ...(restore ? {} : autoRollout.haltFieldsOnManualChange(flag, 'archived')),
        updated_by: req.user?.id || null,
      });

      await featureFlags.invalidate();
      return res.json({ success: true, data: flag });
    } catch (error) {
      logger.error(`[featureFlags] archive: ${error.message}`);
      return fail(res, 500, 'Impossible d\'archiver le drapeau');
    }
  },

  /**
   * POST /api/feature-flags/admin/:key/simulate
   * « Est-ce que CET utilisateur verrait la fonctionnalité, et pourquoi ? »
   *
   * Répond avec le motif exact de la décision. C'est la réponse à la question
   * qui revient toujours quand un déploiement progressif est en cours, et la
   * seule alternative honnête à « ça doit être le hasard ».
   */
  async simulate(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      let context = { ...(req.body.context || {}) };

      const target = req.body.username || req.body.user_id;
      if (target) {
        const user = await User.findOne({
          where: req.body.user_id
            ? { id: req.body.user_id }
            : { username: { [Op.iLike]: String(req.body.username).replace(/^@/, '') } },
          attributes: [
            'id',
            'username',
            'role',
            'verified',
            'premium',
            'subscription_tier',
            'preferred_language',
            'is_data_test',
            'stats',
            'createdAt',
          ],
        });
        if (!user) return fail(res, 404, 'Utilisateur introuvable');
        context = featureFlags.contextFromUser(user, context);
      }

      const definition = flag.toDefinition();
      const fullContext = await featureFlags.resolveLazyAttributes(context, { [flag.key]: definition });
      const decision = evaluator.evaluate(definition, fullContext);

      return res.json({ success: true, data: { decision, context: fullContext } });
    } catch (error) {
      logger.error(`[featureFlags] simulate: ${error.message}`);
      return fail(res, 500, 'Simulation impossible');
    }
  },

  /**
   * GET /api/feature-flags/admin/:key/exposure
   * Estimation de l'audience touchée.
   *
   * ⚠️ C'est une ESTIMATION sur échantillon, pas un décompte. Évaluer le
   * drapeau pour chaque compte de la base à chaque ouverture de l'écran serait
   * une requête pleine table sur un chemin d'administration : on tire un
   * échantillon borné et on extrapole. La marge est renvoyée avec le résultat
   * pour qu'on ne lise pas le chiffre comme exact.
   */
  async exposure(req, res) {
    try {
      const flag = await FeatureFlag.findOne({ where: { key: req.params.key } });
      if (!flag) return fail(res, 404, 'Drapeau introuvable');

      const sampleSize = Math.min(parseInt(req.query.sample, 10) || 2000, 10000);
      const definition = flag.toDefinition();

      const total = await User.count({ where: { is_active: true } });
      const sample = await User.findAll({
        where: { is_active: true },
        attributes: [
          'id',
          'username',
          'role',
          'verified',
          'premium',
          'subscription_tier',
          'preferred_language',
          'is_data_test',
          'stats',
          'createdAt',
        ],
        order: [['createdAt', 'DESC']],
        limit: sampleSize,
      });

      let matched = 0;
      const byVariant = {};
      for (const user of sample) {
        const decision = evaluator.evaluate(definition, featureFlags.contextFromUser(user));
        if (!decision.enabled) continue;
        matched += 1;
        const bucketName = decision.variant || 'on';
        byVariant[bucketName] = (byVariant[bucketName] || 0) + 1;
      }

      const ratio = sample.length > 0 ? matched / sample.length : 0;

      return res.json({
        success: true,
        data: {
          sampled: sample.length,
          matched,
          ratio,
          estimated_users: Math.round(ratio * total),
          total_active_users: total,
          by_variant: byVariant,
          // Les attributs techniques (plateforme, version) sont absents d'un
          // contexte reconstruit depuis la base : un segment qui les utilise
          // sera donc sous-estimé ici. Le dire plutôt que de laisser croire.
          caveat:
            'Estimation sur un échantillon des comptes actifs les plus récents ; les conditions sur la plateforme ou la version de l\'app ne sont pas évaluables hors requête réelle.',
        },
      });
    } catch (error) {
      logger.error(`[featureFlags] exposure: ${error.message}`);
      return fail(res, 500, 'Estimation impossible');
    }
  },
};
