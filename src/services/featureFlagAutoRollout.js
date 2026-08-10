'use strict';

/**
 * 🚩 Montée automatique du palier — la fonctionnalité élargit sa portée seule.
 *
 * Le déploiement progressif à la main a un défaut connu : personne ne remonte
 * le palier. Un drapeau part à 5 %, la semaine passe, et six mois plus tard la
 * fonctionnalité est toujours réservée à 5 % des comptes parce que le geste
 * n'appartenait à personne. Armer une montée, c'est décider UNE FOIS de la
 * trajectoire complète au lieu de devoir s'en souvenir six fois.
 *
 * ── Ce que le plan fait ──
 * Il fait avancer le palier le long d'une échelle, un cran par intervalle.
 * Rien d'autre : il n'allume pas un drapeau éteint, ne change jamais le
 * ciblage, ne touche ni aux testeurs ni aux variantes.
 *
 * ── Ce qui l'arrête ──
 *   - le dernier cran est atteint          → `completed_at` ;
 *   - quelqu'un éteint le drapeau          → arrêt, motif `flag_off` ;
 *   - quelqu'un change le palier à la main → arrêt, motif `manual_override` ;
 *   - le ciblage devient multi-segments    → arrêt, motif `targeting_changed`.
 *
 * Le troisième point est le plus important. Sans lui, un modérateur qui
 * redescend un palier en urgence verrait la montée le remonter à l'intervalle
 * suivant — l'automatisme se battrait contre l'humain, et gagnerait. Un plan
 * arrêté n'est jamais repris tout seul : il faut le réarmer explicitement.
 *
 * ── Où vit le palier ──
 * Un drapeau ciblé (« 10 % des comptes certifiés ») porte son pourcentage sur
 * son segment, pas sur `rollout_percentage` — c'est la forme qu'écrit l'écran
 * d'administration. La montée écrit donc au même endroit que l'écran, sinon
 * armer un drapeau ciblé ne changerait rien de visible.
 */

const { Op } = require('sequelize');
const logger = require('../utils/logger');
const evaluator = require('./featureFlagEvaluator');

/** Échelle par défaut. Les petits crans d'abord : c'est là qu'on observe. */
const DEFAULT_STEPS = [1, 5, 10, 25, 50, 100];

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30; // 30 jours
const DEFAULT_INTERVAL_MINUTES = 60 * 24; // un cran par jour

/**
 * Le planificateur bat à la minute. La granularité utile se compte en heures :
 * ce battement ne sert qu'à ne pas décaler la montée d'un intervalle entier
 * quand l'échéance tombe entre deux tours.
 */
const TICK_INTERVAL_MS = 60000;

const HALT_REASONS = {
  flag_off: 'Le drapeau a été éteint',
  manual_override: 'Le palier a été changé à la main',
  targeting_changed: 'Le ciblage a été découpé en plusieurs segments',
  archived: 'Le drapeau a été archivé',
};

let timer = null;

// ─────────────────────────── Lecture du palier ───────────────────────────

/**
 * Index du segment qui porte le palier à faire monter, ou `-1` si c'est le
 * palier global.
 *
 * Un segment « boost » ne compte pas : il est relatif au palier global et
 * monte donc tout seul quand celui-ci monte. Faire grimper le boost
 * reviendrait à l'élargir deux fois.
 */
function absoluteRuleIndexes(flag) {
  const rules = Array.isArray(flag?.rules) ? flag.rules : [];
  return rules.reduce((found, rule, index) => {
    if (!evaluator.isBoostRule(rule)) found.push(index);
    return found;
  }, []);
}

/** Palier réellement servi : celui du segment absolu quand il y en a un. */
function effectiveStep(flag) {
  const [index] = absoluteRuleIndexes(flag);
  if (index === undefined) {
    return Math.max(0, Math.min(100, Number(flag?.rollout_percentage) || 0));
  }
  const percentage = flag.rules[index].percentage;
  if (percentage === undefined || percentage === null) return 100;
  return Math.max(0, Math.min(100, Number(percentage) || 0));
}

/** Champs à écrire pour poser `value` là où le palier est réellement lu. */
function stepUpdate(flag, value) {
  const [index] = absoluteRuleIndexes(flag);
  if (index === undefined) return { rollout_percentage: value };

  const rules = flag.rules.map((rule, position) =>
    position === index ? { ...rule, percentage: value } : rule
  );
  return { rules };
}

// ─────────────────────────────── Le plan ───────────────────────────────

function sanitizeSteps(input) {
  if (!Array.isArray(input) || input.length === 0) return [...DEFAULT_STEPS];

  const cleaned = [
    ...new Set(
      input
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= 100)
    ),
  ].sort((a, b) => a - b);

  if (cleaned.length === 0) throw new Error('L\'échelle doit contenir au moins un palier entre 1 et 100');
  return cleaned;
}

/** Premier cran STRICTEMENT au-dessus du palier courant, ou `null` en haut. */
function nextStep(steps, current) {
  for (const step of steps) {
    if (step > current) return step;
  }
  return null;
}

function iso(date) {
  return new Date(date).toISOString();
}

function plusMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

/**
 * Construit le plan d'un drapeau. Lève si la montée n'aurait aucun sens —
 * mieux vaut un refus explicite qu'un plan armé qui ne bougera jamais.
 */
function buildPlan(flag, { steps, interval_minutes: intervalMinutes, actorId } = {}, now = new Date()) {
  if (absoluteRuleIndexes(flag).length > 1) {
    throw new Error(
      'Montée impossible sur un ciblage à plusieurs segments : le palier à faire monter serait ambigu.'
    );
  }

  const ladder = sanitizeSteps(steps);
  const current = effectiveStep(flag);

  if (nextStep(ladder, current) === null) {
    throw new Error(`Le palier est déjà à ${current} % : aucun cran plus haut dans l'échelle.`);
  }

  const rawInterval = Number(intervalMinutes);
  const interval = Number.isFinite(rawInterval)
    ? Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(rawInterval)))
    : DEFAULT_INTERVAL_MINUTES;

  return {
    enabled: true,
    steps: ladder,
    interval_minutes: interval,
    started_at: iso(now),
    // Le premier cran n'est pas immédiat : l'intervalle sert à observer le
    // palier courant, y compris celui depuis lequel on arme.
    next_at: iso(plusMinutes(now, interval)),
    last_step_at: null,
    armed_by: actorId || null,
    halted_at: null,
    halted_reason: null,
    completed_at: null,
  };
}

function haltPlan(plan, reason, now = new Date()) {
  if (!plan || plan.halted_at || plan.completed_at) return plan || null;
  return {
    ...plan,
    enabled: false,
    next_at: null,
    halted_at: iso(now),
    halted_reason: reason,
  };
}

function isActive(plan) {
  return Boolean(plan && plan.enabled && !plan.halted_at && !plan.completed_at);
}

function isDue(plan, now = new Date()) {
  return isActive(plan) && Boolean(plan.next_at) && new Date(plan.next_at) <= now;
}

/**
 * Ce qu'il faut écrire pour faire avancer ce drapeau d'un cran, ou `null` si
 * rien n'est à faire. Fonction PURE : la persistance est au tour de boucle,
 * ce qui rend la trajectoire testable sans base de données.
 */
function computeAdvance(flag, now = new Date()) {
  const plan = flag.auto_rollout;
  if (!isDue(plan, now)) return null;

  if (flag.archived_at) return { auto_rollout: haltPlan(plan, 'archived', now) };
  if (!flag.enabled) return { auto_rollout: haltPlan(plan, 'flag_off', now) };
  if (absoluteRuleIndexes(flag).length > 1) {
    return { auto_rollout: haltPlan(plan, 'targeting_changed', now) };
  }

  const current = effectiveStep(flag);
  const target = nextStep(plan.steps, current);

  // Plus rien au-dessus : le plan a fait son travail.
  if (target === null) {
    return { auto_rollout: { ...plan, enabled: false, next_at: null, completed_at: iso(now) } };
  }

  const done = nextStep(plan.steps, target) === null;

  return {
    ...stepUpdate(flag, target),
    auto_rollout: {
      ...plan,
      last_step_at: iso(now),
      next_at: done ? null : iso(plusMinutes(now, plan.interval_minutes)),
      enabled: !done,
      completed_at: done ? iso(now) : null,
    },
    __from: current,
    __to: target,
  };
}

// ──────────────────────── Écritures depuis les routes ────────────────────────

/** Arme (ou remplace) le plan d'un drapeau déjà chargé. Persiste. */
async function arm(flag, options = {}, now = new Date()) {
  const plan = buildPlan(flag, options, now);
  await flag.update({ auto_rollout: plan, updated_by: options.actorId || flag.updated_by });
  logger.info(
    `[featureFlags] montée armée "${flag.key}" : ${plan.steps.join(' → ')} %, un cran / ${plan.interval_minutes} min`
  );
  return plan;
}

/** Désarme. `auto_rollout` repasse à `null` : plus aucune trace de plan. */
async function disarm(flag, actorId = null) {
  if (!flag.auto_rollout) return null;
  await flag.update({ auto_rollout: null, updated_by: actorId || flag.updated_by });
  logger.info(`[featureFlags] montée désarmée "${flag.key}"`);
  return null;
}

/**
 * Arrête le plan d'un drapeau modifié à la main, si un plan tourne encore.
 * Renvoie les champs à fusionner dans la mise à jour en cours — l'appelant
 * n'écrit ainsi qu'une seule fois.
 */
function haltFieldsOnManualChange(flag, reason = 'manual_override', now = new Date()) {
  if (!isActive(flag.auto_rollout)) return {};
  logger.info(`[featureFlags] montée arrêtée "${flag.key}" (${reason})`);
  return { auto_rollout: haltPlan(flag.auto_rollout, reason, now) };
}

/** Résumé lisible d'un plan, pour l'écran d'administration. */
function describe(plan, currentStep = 0) {
  if (!plan) return null;
  if (plan.completed_at) return 'Montée terminée';
  if (plan.halted_at) return `Montée arrêtée — ${HALT_REASONS[plan.halted_reason] || plan.halted_reason}`;
  const target = nextStep(plan.steps, currentStep);
  if (target === null) return 'Montée armée, aucun cran plus haut';
  return `Prochain palier : ${target} %`;
}

// ────────────────────────────── Tour de boucle ──────────────────────────────

/**
 * Un tour : fait avancer tous les drapeaux dont l'échéance est passée.
 *
 * La table tient en quelques dizaines de lignes, donc on charge les drapeaux
 * armés et on filtre en mémoire plutôt que de comparer une date dans du JSONB
 * en SQL. L'index partiel de la migration sert à ne lire que ces lignes-là.
 *
 * Ne lève jamais : une panne ici doit laisser les paliers en place, pas
 * arrêter le process qui sert le trafic.
 */
async function tick(now = new Date()) {
  const { FeatureFlag } = require('../models');
  const featureFlags = require('./featureFlagService');

  let advanced = 0;
  try {
    const flags = await FeatureFlag.findAll({
      where: { archived_at: null, auto_rollout: { [Op.ne]: null } },
    });

    for (const flag of flags) {
      const changes = computeAdvance(flag, now);
      if (!changes) continue;

      const { __from: from, __to: to, ...persisted } = changes;
      try {
        await flag.update(persisted);
        advanced += 1;

        if (to !== undefined) {
          logger.info(`[featureFlags] montée automatique "${flag.key}" ${from} % → ${to} %`);
        } else if (persisted.auto_rollout?.halted_reason) {
          logger.warn(
            `[featureFlags] montée arrêtée "${flag.key}" (${persisted.auto_rollout.halted_reason})`
          );
        } else if (persisted.auto_rollout?.completed_at) {
          logger.info(`[featureFlags] montée terminée "${flag.key}"`);
        }
      } catch (error) {
        logger.error(`[featureFlags] montée impossible "${flag.key}": ${error.message}`);
      }
    }

    // Une seule invalidation pour tout le tour : les process du parc n'ont pas
    // besoin d'un message par drapeau.
    if (advanced > 0) await featureFlags.invalidate();
  } catch (error) {
    logger.error(`[featureFlags] tour de montée automatique impossible: ${error.message}`);
  }

  return advanced;
}

/**
 * Planificateur — process worker UNIQUEMENT (voir `config/role.js`). Sur deux
 * instances, un même drapeau monterait de deux crans par intervalle.
 */
function startScheduler({ intervalMs = TICK_INTERVAL_MS } = {}) {
  if (timer) return;
  if (process.env.FEATURE_FLAGS_AUTO_ROLLOUT === 'false') {
    logger.info('[featureFlags] Montée automatique désactivée par FEATURE_FLAGS_AUTO_ROLLOUT=false.');
    return;
  }

  timer = setInterval(() => {
    tick().catch(() => { /* déjà journalisé */ });
  }, intervalMs);

  logger.info('🚩 Montée automatique des drapeaux planifiée (vérification chaque minute).');
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  DEFAULT_STEPS,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
  HALT_REASONS,
  absoluteRuleIndexes,
  effectiveStep,
  stepUpdate,
  sanitizeSteps,
  nextStep,
  buildPlan,
  haltPlan,
  isActive,
  isDue,
  computeAdvance,
  arm,
  disarm,
  haltFieldsOnManualChange,
  describe,
  tick,
  startScheduler,
  stopScheduler,
};
