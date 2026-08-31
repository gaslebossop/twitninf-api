const { v4: uuidv4 } = require('uuid');
const { sequelize, User, UserFollow } = require('../models');
const { evaluateTweetForRecommendations } = require('./geminiService');
const featureFlagService = require('./featureFlagService');
const logger = require('../utils/logger');

const MIN_FOLLOWERS = 11; // « plus de 10 »
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 4;
const MAX_CONTENT_LENGTH = 600;
const WINDOWS_CLIENT = 'windows-electron';
const MOBILE_CLIENT = 'mobile-expo';

/**
 * Drapeau qui ouvre l'A/B au mobile.
 *
 * C'est le MEME que celui qui decide, cote lecture, si un lecteur recoit des
 * variantes (`neuralRankRoutes`) : etre dans la cohorte A/B, c'est etre dedans
 * des deux cotes. Deux drapeaux separes auraient permis d'ecrire un test que
 * personne dans sa cohorte ne peut voir.
 */
const AB_TEST_FLAG = 'fil.abtest';
const TARGET_TOTAL_IMPRESSIONS = 16;
const MIN_IMPRESSIONS_FLOOR = 4;
const MAX_CONCURRENT_EXPERIMENTS = 2;

class AbTestRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AbTestRequestError';
    this.status = status;
  }
}

function normalizeExperimentRequest(raw, primaryContent) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.variants)) {
    throw new AbTestRequestError('Le format de l’expérience A/B est invalide.');
  }

  const contents = [
    String(primaryContent || '').trim(),
    ...raw.variants.map(value => String(value || '').trim()),
  ];

  if (contents.length < MIN_VARIANTS || contents.length > MAX_VARIANTS) {
    throw new AbTestRequestError(`Une expérience A/B doit contenir entre ${MIN_VARIANTS} et ${MAX_VARIANTS} versions.`);
  }
  if (contents.some(value => !value)) {
    throw new AbTestRequestError('Toutes les versions de l’expérience doivent être remplies.');
  }
  if (contents.some(value => value.length > MAX_CONTENT_LENGTH)) {
    throw new AbTestRequestError(`Chaque version est limitée à ${MAX_CONTENT_LENGTH} caractères.`);
  }
  if (new Set(contents).size !== contents.length) {
    throw new AbTestRequestError('Les versions de l’expérience doivent être différentes.');
  }

  return {
    contents,
    strategy: raw.strategy === 'adaptive' ? 'adaptive' : 'adaptive',
  };
}

/**
 * Ce client peut-il LANCER une experience A/B ?
 *
 * Windows passe toujours : c'est la population de test d'origine, et la
 * retirer casserait un usage en cours. Le mobile entre derriere `fil.abtest`,
 * par paliers — ecrire une experience change ce que les lecteurs voient, ca ne
 * s'ouvre pas d'un coup sur tout le parc.
 *
 * Les autres clients (web, integrations) restent dehors : rien n'y compose de
 * variantes aujourd'hui, et une porte ouverte sans interface derriere est une
 * porte qu'on oublie de refermer.
 */
async function clientMayAuthor(client, flagContext) {
  const normalized = String(client || '').trim().toLowerCase();
  if (normalized === WINDOWS_CLIENT) return true;
  if (normalized !== MOBILE_CLIENT) return false;

  // /!\ Le contexte doit etre COMPLET, pas juste `{ user_id }`.
  //
  // La liste d'acces d'un drapeau accepte un identifiant OU un pseudo OU un
  // identifiant d'appareil (`featureFlagEvaluator.listedIn`). Un contexte
  // reduit a `user_id` ne peut donc pas reconnaitre une entree ecrite en
  // pseudo — et c'est ainsi qu'elles sont ecrites depuis l'ecran d'admin.
  //
  // Le symptome est particulierement trompeur : l'app, elle, resout ses
  // drapeaux avec le contexte complet de la requete, donc elle AFFICHE la
  // fonctionnalite. C'est seulement a la publication que le serveur, evaluant
  // le meme drapeau avec moins d'informations, repond non. Le testeur voit un
  // bouton qui refuse de marcher.
  return featureFlagService.isEnabled(AB_TEST_FLAG, flagContext || {});
}

async function assertEligible({ userId, client, parentTweetId, isPrivate, flagContext }) {
  if (!(await clientMayAuthor(client, flagContext || { user_id: userId }))) {
    throw new AbTestRequestError('La bêta A/B n’est pas encore ouverte sur ce client.', 403);
  }
  if (parentTweetId) {
    throw new AbTestRequestError('Une réponse ne peut pas lancer une expérience A/B.');
  }
  if (isPrivate) {
    throw new AbTestRequestError('Une expérience A/B doit être une publication publique.');
  }

  const [account, followers] = await Promise.all([
    User.findByPk(userId, { attributes: ['id', 'verified'] }),
    UserFollow.countFollowers(userId),
  ]);
  if (!account) throw new AbTestRequestError('Compte introuvable.', 401);
  if (!account.verified || Number(followers) < MIN_FOLLOWERS) {
    throw new AbTestRequestError(
      'La bêta A/B est réservée aux comptes certifiés ayant plus de 10 abonnés.',
      403,
    );
  }
}

/**
 * D'ou vient l'experience, pour la colonne `platform_scope`.
 *
 * Rien ne LIT cette colonne aujourd'hui — elle documente l'origine. Mais elle
 * etait ecrite en dur a `'windows'`, et une colonne qui ment sur la moitie de
 * ses lignes finit par etre lue un jour, dans un tableau de bord ou une
 * requete d'analyse.
 */
function platformScopeFor(client) {
  const normalized = String(client || '').trim().toLowerCase();
  if (normalized === MOBILE_CLIENT) return 'mobile';
  if (normalized === WINDOWS_CLIENT) return 'windows';
  return 'unknown';
}

async function createExperiment({ tweetId, authorId, contents, client, transaction }) {
  // La plateforme compte encore une petite audience active. Sérialiser ce
  // contrôle évite que plusieurs créations concurrentes fragmentent le trafic.
  await sequelize.query(
    `SELECT pg_advisory_xact_lock(hashtext('twitninf_ab_experiment_capacity'))`,
    { transaction },
  );
  const [capacityRows] = await sequelize.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('pending', 'active'))::int AS platform_count,
      COUNT(*) FILTER (
        WHERE status IN ('pending', 'active') AND author_id = :authorId
      )::int AS author_count
    FROM tweet_ab_experiments
  `, {
    replacements: { authorId },
    transaction,
  });
  const capacity = capacityRows?.[0] || {};
  if (Number(capacity.author_count || 0) >= 1) {
    throw new AbTestRequestError(
      'Attendez la fin de votre expérience A/B actuelle avant d’en lancer une autre.',
      409,
    );
  }
  if (Number(capacity.platform_count || 0) >= MAX_CONCURRENT_EXPERIMENTS) {
    throw new AbTestRequestError(
      'Les places de test A/B sont occupées. Réessayez après la fin d’une expérience en cours.',
      429,
    );
  }

  const experimentId = uuidv4();
  const minImpressionsPerVariant = Math.max(
    MIN_IMPRESSIONS_FLOOR,
    Math.ceil(TARGET_TOTAL_IMPRESSIONS / contents.length),
  );
  await sequelize.query(`
    INSERT INTO tweet_ab_experiments (
      id, tweet_id, author_id, status, strategy, platform_scope,
      exploration_percent, min_impressions_per_variant, created_at, updated_at
    ) VALUES (
      :id, :tweetId, :authorId, 'pending', 'adaptive', :platformScope,
      20, :minImpressionsPerVariant, NOW(), NOW()
    )
  `, {
    replacements: {
      id: experimentId,
      tweetId,
      authorId,
      platformScope: platformScopeFor(client),
      minImpressionsPerVariant,
    },
    transaction,
  });

  const variants = [];
  for (let position = 0; position < contents.length; position += 1) {
    const variant = {
      id: uuidv4(),
      experimentId,
      position,
      label: String.fromCharCode(65 + position),
      content: contents[position],
    };
    await sequelize.query(`
      INSERT INTO tweet_ab_variants (
        id, experiment_id, position, label, content, is_control,
        moderation_status, created_at, updated_at
      ) VALUES (
        :id, :experimentId, :position, :label, :content, :isControl,
        'pending', NOW(), NOW()
      )
    `, {
      replacements: { ...variant, isControl: position === 0 },
      transaction,
    });
    await sequelize.query(`
      INSERT INTO tweet_ab_variant_metrics (variant_id, impressions, interactions, reward, updated_at)
      VALUES (:variantId, 0, 0, 0, NOW())
      ON CONFLICT (variant_id) DO NOTHING
    `, {
      replacements: { variantId: variant.id },
      transaction,
    });
    variants.push(variant);
  }

  return { id: experimentId, variants };
}

async function cancelExperiment(experimentId, reason) {
  if (!experimentId) return;
  await sequelize.query(`
    UPDATE tweet_ab_experiments
    SET status = 'cancelled', cancellation_reason = :reason, updated_at = NOW()
    WHERE id = :experimentId AND status IN ('pending', 'active')
  `, {
    replacements: { experimentId, reason: String(reason || 'cancelled').slice(0, 500) },
  });
}

/**
 * La version A a déjà suivi le pipeline normal du tweet. Les alternatives
 * passent ici dans le même évaluateur avant que Rust puisse les distribuer.
 */
async function moderateAndActivateExperiment(experimentId, authorUsername) {
  const [variants] = await sequelize.query(`
    SELECT id, position, content
    FROM tweet_ab_variants
    WHERE experiment_id = :experimentId
    ORDER BY position ASC
  `, { replacements: { experimentId } });

  if (!Array.isArray(variants) || variants.length < MIN_VARIANTS) {
    await cancelExperiment(experimentId, 'variants_missing');
    return { active: false, reason: 'variants_missing' };
  }

  let allApproved = true;
  for (const variant of variants) {
    if (Number(variant.position) === 0) {
      await sequelize.query(`
        UPDATE tweet_ab_variants
        SET moderation_status = 'approved', moderation_reason = NULL, updated_at = NOW()
        WHERE id = :variantId
      `, { replacements: { variantId: variant.id } });
      continue;
    }

    try {
      const result = await evaluateTweetForRecommendations({
        content: variant.content,
        authorUsername,
        isReply: false,
      });
      const approved = result?.decision !== 'ban' && result?.decision !== 'not_eligible';
      allApproved = allApproved && approved;
      await sequelize.query(`
        UPDATE tweet_ab_variants
        SET moderation_status = :status, moderation_reason = :reason, updated_at = NOW()
        WHERE id = :variantId
      `, {
        replacements: {
          variantId: variant.id,
          status: approved ? 'approved' : 'rejected',
          reason: approved ? null : String(result?.reason || result?.decision || 'rejected').slice(0, 500),
        },
      });
    } catch (error) {
      allApproved = false;
      await sequelize.query(`
        UPDATE tweet_ab_variants
        SET moderation_status = 'rejected', moderation_reason = :reason, updated_at = NOW()
        WHERE id = :variantId
      `, {
        replacements: {
          variantId: variant.id,
          reason: `moderation_error:${String(error?.message || error).slice(0, 450)}`,
        },
      });
    }
  }

  if (!allApproved) {
    await cancelExperiment(experimentId, 'one_or_more_variants_rejected');
    logger.warn(`[A/B] Expérience ${experimentId} annulée : une alternative n’a pas passé la modération`);
    return { active: false, reason: 'variant_rejected' };
  }

  await sequelize.query(`
    UPDATE tweet_ab_experiments
    SET status = 'active', activated_at = NOW(), updated_at = NOW()
    WHERE id = :experimentId AND status = 'pending'
  `, { replacements: { experimentId } });
  logger.info(`[A/B] Expérience ${experimentId} activée avec ${variants.length} versions`);
  return { active: true };
}

module.exports = {
  AbTestRequestError,
  normalizeExperimentRequest,
  assertEligible,
  clientMayAuthor,
  platformScopeFor,
  createExperiment,
  cancelExperiment,
  moderateAndActivateExperiment,
};
