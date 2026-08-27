'use strict';

/**
 * Traduction automatique des tweets — fonctionnalité « Traduction (bêta) »
 * réservée aux abonnés Pro.
 *
 * Le tweet est traduit UNE fois, après modération, dans les 10 langues de
 * `TARGET_LANGUAGES`. Les lecteurs changent ensuite de langue sur le tweet
 * sans qu'aucun appel au LLM ne soit fait à la lecture : tout est déjà en
 * base. C'est ce qui rend l'option tenable côté coût — sinon chaque scroll
 * d'un lecteur déclencherait une génération.
 *
 * Fournisseur : Codex CLI (OpenAI), même pont que PolicierCongo, avec le
 * modèle `gpt-5.4-mini` par défaut (surchargeable via
 * `TRANSLATION_CODEX_MODEL`). Effort de raisonnement bas : traduire un texte
 * court n'a pas besoin de plus, et le temps de réponse compte ici.
 */

const crypto = require('crypto');
const { Tweet, TweetTranslation, User } = require('../models');
const { generateWithCodex } = require('./policiercongo/codexClient');
const { isSubscriptionActive, isProOrAbove } = require('../utils/subscriptionHelpers');
const logger = require('../utils/logger');

const CODEX_MODEL = process.env.TRANSLATION_CODEX_MODEL || 'gpt-5.4-mini';
const CODEX_REASONING_EFFORT = process.env.TRANSLATION_CODEX_REASONING_EFFORT || 'low';

/** Les 10 langues cibles de la bêta. L'ordre est celui affiché dans l'app. */
const TARGET_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];

const TARGET_CODES = TARGET_LANGUAGES.map((language) => language.code);

/** Langue d'origine des tweets — un lecteur peut la choisir comme langue de lecture. */
const SOURCE_LANGUAGE = 'fr';

/** Les 11 valeurs acceptables pour `users.preferred_language`. */
const READABLE_LANGUAGES = [SOURCE_LANGUAGE, ...TARGET_CODES];

/** Un tweet plus long que ça n'est pas un titre : on refuse plutôt que de tronquer. */
const MAX_SOURCE_CHARS = 2000;

function sourceHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 64);
}

/**
 * Droit d'activer l'option à la publication.
 *
 * Relit l'utilisateur EN BASE : le jeton porte `subscription_tier` mais pas
 * `subscription_expires_at`, donc s'y fier laisserait un Pro expiré continuer
 * à consommer des traductions jusqu'au renouvellement de son jeton — même
 * piège que `resolveTweetCharLimit` dans `utils/tweetLimits.js`.
 */
async function canUseTranslation(tokenUser) {
  if (!tokenUser?.id) return false;
  try {
    const user = await User.findByPk(tokenUser.id, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at'],
    });
    if (!user) return false;
    return isProOrAbove(user.subscription_tier) && isSubscriptionActive(user);
  } catch (error) {
    logger.error(`[translation] Vérification du palier impossible: ${error.message}`);
    return false;
  }
}

function buildPrompt(content, sourceLanguage) {
  const languageList = TARGET_LANGUAGES
    .map((language) => `- ${language.code} (${language.label})`)
    .join('\n');

  return [
    'Tu es un traducteur professionnel pour un réseau social.',
    `Traduis le message ci-dessous depuis "${sourceLanguage || 'fr'}" vers chacune des langues suivantes :`,
    languageList,
    '',
    'Règles :',
    "- garde le ton, le registre et la ponctuation expressive de l'original ;",
    '- ne traduis PAS les @mentions, les #hashtags ni les URL : recopie-les tels quels ;',
    '- ne rajoute aucun commentaire, aucune note, aucun emoji absent de la source ;',
    '- si une langue ne permet pas une traduction fidèle, rends la formulation la plus proche.',
    '',
    'Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :',
    `{${TARGET_CODES.map((code) => `"${code}": "..."`).join(', ')}}`,
    '',
    'Message à traduire (entre les balises) :',
    '<message>',
    content,
    '</message>',
  ].join('\n');
}

function parseTranslations(raw) {
  if (!raw) return null;
  // Le modèle enrobe parfois l'objet dans du texte : on isole le premier bloc JSON.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    logger.warn(`[translation] Réponse LLM non parsable: ${error.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const cleaned = {};
  for (const code of TARGET_CODES) {
    const value = parsed[code];
    if (typeof value === 'string' && value.trim()) {
      cleaned[code] = value.trim();
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Génère et enregistre les traductions d'un tweet.
 *
 * Ne jette jamais : la traduction est un bonus, son échec ne doit pas
 * remettre en cause la publication déjà faite. Retourne le nombre de langues
 * effectivement enregistrées.
 *
 * @param {string} tweetId
 * @returns {Promise<number>}
 */
async function translateTweet(tweetId) {
  try {
    const tweet = await Tweet.findByPk(tweetId, {
      attributes: ['id', 'content', 'language', 'translation_enabled'],
    });
    if (!tweet) {
      logger.warn(`[translation] Tweet ${tweetId} introuvable`);
      return 0;
    }
    if (!tweet.translation_enabled) return 0;

    const content = String(tweet.content || '').trim();
    if (!content) return 0;
    if (content.length > MAX_SOURCE_CHARS) {
      logger.warn(`[translation] Tweet ${tweetId} trop long (${content.length} caractères), ignoré`);
      return 0;
    }

    const startedAt = Date.now();
    const raw = await generateWithCodex(
      buildPrompt(content, tweet.language),
      CODEX_MODEL,
      CODEX_REASONING_EFFORT,
    );
    const translations = parseTranslations(raw);
    if (!translations) {
      logger.warn(`[translation] Aucune traduction exploitable pour le tweet ${tweetId}`);
      return 0;
    }

    const hash = sourceHash(content);
    const rows = Object.entries(translations).map(([language, translated]) => ({
      tweet_id: tweet.id,
      language,
      source_language: tweet.language || null,
      content: translated,
      source_hash: hash,
      provider: 'codex',
      model: CODEX_MODEL,
    }));

    await TweetTranslation.bulkCreate(rows, {
      updateOnDuplicate: ['content', 'source_language', 'source_hash', 'provider', 'model', 'updated_at'],
    });

    logger.info(
      `[translation] Tweet ${tweetId} traduit en ${rows.length} langues ` +
      `(model=${CODEX_MODEL}, durationMs=${Date.now() - startedAt})`,
    );
    return rows.length;
  } catch (error) {
    logger.error(`[translation] Échec de la traduction du tweet ${tweetId}: ${error.message}`);
    return 0;
  }
}

/** Traductions disponibles d'un tweet, dans l'ordre d'affichage de `TARGET_LANGUAGES`. */
async function getTranslations(tweetId) {
  const rows = await TweetTranslation.findAll({
    where: { tweet_id: tweetId },
    attributes: ['language', 'content', 'source_language', 'model', 'updated_at'],
  });

  const byCode = new Map(rows.map((row) => [row.language, row]));
  return TARGET_LANGUAGES
    .filter((language) => byCode.has(language.code))
    .map((language) => {
      const row = byCode.get(language.code);
      return {
        language: language.code,
        label: language.label,
        content: row.content,
        source_language: row.source_language,
        model: row.model,
        updated_at: row.updated_at,
      };
    });
}

/**
 * Traductions de PLUSIEURS tweets dans une seule langue.
 *
 * Sert le fil : une page de tweets se résout en un appel, au lieu d'un appel
 * par carte. Retourne une map `{ [tweet_id]: { language, label, content } }` —
 * les tweets sans traduction dans cette langue sont simplement absents.
 */
async function getTranslationsForLanguage(tweetIds, language) {
  const ids = [...new Set((tweetIds || []).map(String))].filter(Boolean);
  if (ids.length === 0) return {};
  if (!TARGET_CODES.includes(language)) return {};

  const rows = await TweetTranslation.findAll({
    where: { tweet_id: ids, language },
    attributes: ['tweet_id', 'language', 'content'],
  });

  const label = TARGET_LANGUAGES.find((item) => item.code === language)?.label || language;
  const result = {};
  for (const row of rows) {
    result[row.tweet_id] = { language: row.language, label, content: row.content };
  }
  return result;
}

module.exports = {
  TARGET_LANGUAGES,
  TARGET_CODES,
  SOURCE_LANGUAGE,
  READABLE_LANGUAGES,
  getTranslationsForLanguage,
  canUseTranslation,
  translateTweet,
  getTranslations,
};
