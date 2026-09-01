const { Op } = require('sequelize');
const { ProfileView, User, UserPreferences } = require('../models');
const { sequelize } = require('../database/index');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const {
  PROFILE_VIEW_RETENTION_DAYS,
  PROFILE_VIEW_WINDOW_DAYS,
  PROFILE_VIEW_WINDOW_DAYS_ULTRA,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * « Qui a consulté ton profil » — avantage abonné.
 *
 * C'est la fonctionnalité la plus délicate du lot : elle transforme une
 * action jusqu'ici invisible en information vendue à un tiers. Trois garde-fous
 * la rendent tenable, et ils ne sont pas négociables :
 *
 * 1. **Agrégation par jour.** On retient QUI, jamais à quelle heure ni combien
 *    de fois. Un journal horodaté dirait à quelqu'un le moment précis où on
 *    pense à lui.
 * 2. **Mode discret pour les abonnés.** Qui peut voir peut aussi se cacher.
 *    Sans réciprocité, l'abonnement se vendrait sur une surveillance à sens
 *    unique.
 * 3. **Rétention courte.** Trente jours en base, sept jours affichés. Au-delà,
 *    la donnée ne sert plus qu'à reconstituer les habitudes de quelqu'un.
 */

/** Jour UTC d'une date, au format attendu par une colonne DATEONLY. */
function dayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Le visiteur navigue-t-il en discret ? Réservé aux abonnés actifs. */
async function isIncognito(userId) {
  try {
    const [user, prefs] = await Promise.all([
      User.findByPk(userId, {
        attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at'],
      }),
      UserPreferences.findOne({ where: { user_id: userId } }),
    ]);
    if (!isSubscriptionActive(user)) return false;
    return Boolean(prefs?.privacy_settings?.incognito_profile_views);
  } catch (e) {
    // Dans le doute, on ne masque PAS : un faux discret trahirait quelqu'un
    // qui croit être invisible, alors qu'une visite visible de trop n'est que
    // le comportement normal de l'app.
    logger.warn(`[profileViews] Mode discret illisible pour ${userId}: ${e.message}`);
    return false;
  }
}

async function setIncognito(userId, enabled) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at'],
  });
  if (!isSubscriptionActive(user)) {
    throw new Error('La navigation discrète est réservée aux abonnés.');
  }
  const [prefs] = await UserPreferences.findOrCreate({
    where: { user_id: userId },
    defaults: { user_id: userId },
  });
  await prefs.update({
    privacy_settings: { ...(prefs.privacy_settings || {}), incognito_profile_views: Boolean(enabled) },
  });
  return Boolean(enabled);
}

/**
 * Enregistre une visite.
 *
 * Appelée depuis la route de profil, sans être attendue : une visite perdue
 * n'est rien, une page de profil ralentie se voit. Les visites sur son propre
 * profil ne comptent pas — c'est le cas le plus fréquent, et il n'apprend
 * rien à personne.
 */
async function record({ profileId, viewerId }) {
  if (!profileId || !viewerId) return null;
  if (String(profileId) === String(viewerId)) return null;

  try {
    const hidden = await isIncognito(viewerId);
    const viewer = await User.findByPk(viewerId, { attributes: ['subscription_tier'] });
    const today = dayKey();

    const [row, created] = await ProfileView.findOrCreate({
      where: { profile_id: profileId, viewer_id: viewerId, viewed_on: today },
      defaults: {
        profile_id: profileId,
        viewer_id: viewerId,
        viewed_on: today,
        view_count: 1,
        viewer_hidden: hidden,
        viewer_tier: viewer?.subscription_tier || 'free',
      },
    });

    if (!created) {
      await row.increment('view_count');
      // Le mode discret est relu à chaque passage : quelqu'un qui l'active en
      // cours de journée ne doit pas rester visible jusqu'au lendemain.
      if (row.viewer_hidden !== hidden) await row.update({ viewer_hidden: hidden });
    }
    return row;
  } catch (e) {
    logger.warn(`[profileViews] Visite non enregistrée: ${e.message}`);
    return null;
  }
}

/**
 * Profondeur d'historique consultable, par palier : 7 jours, 30 pour Ultra.
 *
 * Ce n'est PAS un plafond de rétention — les visites sont gardées
 * `PROFILE_VIEW_RETENTION_DAYS` pour tout le monde, et rien de plus n'est
 * collecté. L'avantage Ultra est de pouvoir lire jusqu'au bout de ce qui
 * existe déjà.
 */
function maxWindowDaysFor(isUltra) {
  return isUltra ? PROFILE_VIEW_WINDOW_DAYS_ULTRA : PROFILE_VIEW_WINDOW_DAYS;
}

/**
 * Visiteurs récents.
 *
 * Les visiteurs discrets sont comptés dans le total mais jamais nommés :
 * l'abonné voit « 12 visiteurs, dont 3 en navigation discrète », ce qui est
 * honnête sans trahir personne.
 *
 * `maxDays` est la borne du PALIER, résolue par l'appelant (qui seul connaît
 * l'abonné) ; `days` n'est qu'une demande du client. La borne était auparavant
 * un `30` en dur ici, si bien que n'importe quel abonné pouvait demander
 * `?days=30` et obtenir le mois complet : les sept jours annoncés n'étaient
 * qu'une valeur par défaut, jamais une limite.
 */
async function listFor(profileId, { days, maxDays = PROFILE_VIEW_WINDOW_DAYS } = {}) {
  const cap = Math.min(Math.max(parseInt(maxDays, 10) || PROFILE_VIEW_WINDOW_DAYS, 1), PROFILE_VIEW_WINDOW_DAYS_ULTRA);
  const window = Math.min(Math.max(parseInt(days, 10) || cap, 1), cap);
  const since = dayKey(new Date(Date.now() - window * 86400000));

  const rows = await ProfileView.findAll({
    where: { profile_id: profileId, viewed_on: { [Op.gte]: since } },
    include: [{
      model: User,
      as: 'viewer',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier'],
    }],
    order: [['viewed_on', 'DESC']],
    limit: 500,
  });

  const visible = [];
  const seen = new Set();
  let hiddenCount = 0;

  for (const row of rows) {
    if (row.viewer_hidden || !row.viewer) {
      hiddenCount += 1;
      continue;
    }
    const key = String(row.viewer_id);
    if (seen.has(key)) continue; // un visiteur, une ligne, même sur plusieurs jours
    seen.add(key);
    visible.push({
      viewed_on: row.viewed_on,
      user: {
        id: row.viewer.id,
        username: row.viewer.username,
        full_name: row.viewer.full_name,
        avatar: row.viewer.avatar,
        verified: row.viewer.verified,
        verification_style: row.viewer.verification_style,
        premium: row.viewer.premium,
        subscription_tier: row.viewer.subscription_tier,
      },
    });
  }

  return {
    window_days: window,
    total_visitors: seen.size + hiddenCount,
    hidden_visitors: hiddenCount,
    visitors: visible,
  };
}

/** Compteur seul — pour la pastille, sans charger la liste. */
async function countFor(profileId, { days, maxDays = PROFILE_VIEW_WINDOW_DAYS } = {}) {
  const cap = Math.min(Math.max(parseInt(maxDays, 10) || PROFILE_VIEW_WINDOW_DAYS, 1), PROFILE_VIEW_WINDOW_DAYS_ULTRA);
  const window = Math.min(Math.max(parseInt(days, 10) || cap, 1), cap);
  const since = dayKey(new Date(Date.now() - window * 86400000));
  const [row] = await sequelize.query(`
    SELECT COUNT(DISTINCT viewer_id)::int AS visitors
    FROM profile_views
    WHERE profile_id = :profileId AND viewed_on >= :since
  `, {
    replacements: { profileId: String(profileId), since },
    type: sequelize.QueryTypes.SELECT,
  });
  return row?.visitors || 0;
}

/**
 * Purge de rétention. Appelée par le planificateur de tâches.
 * Sans elle, la table grossit indéfiniment pour afficher sept jours.
 */
async function purgeOld() {
  const cutoff = dayKey(new Date(Date.now() - PROFILE_VIEW_RETENTION_DAYS * 86400000));
  const deleted = await ProfileView.destroy({ where: { viewed_on: { [Op.lt]: cutoff } } });
  if (deleted) logger.info(`[profileViews] ${deleted} visites purgées (> ${PROFILE_VIEW_RETENTION_DAYS} j)`);
  return deleted;
}

module.exports = {
  record,
  listFor,
  countFor,
  isIncognito,
  setIncognito,
  purgeOld,
  PROFILE_VIEW_WINDOW_DAYS,
  PROFILE_VIEW_WINDOW_DAYS_ULTRA,
  maxWindowDaysFor,
};
