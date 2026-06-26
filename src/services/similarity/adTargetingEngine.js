/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AD TARGETING ENGINE — Moteur de ciblage publicitaire
 *
 *  Connecte les campagnes publicitaires aux profils targeting des utilisateurs.
 *  
 *  Architecture :
 *    1. Charge les profils targeting depuis la DB SQLite (targeting_v2.db)
 *    2. Matche les critères de campagne contre les profils
 *    3. Score et classe les publicités pour un utilisateur donné
 *    4. Insère les ads dans le feed de recommandation (1 ad / ~10 tweets)
 *
 *  Tables utilisées (targeting SQLite) :
 *    - user_targeting_profiles : groupes assignés par l'IA Groq
 *    - ad_campaigns (future) : campagnes avec critères de ciblage
 *
 *  Pour l'instant : infrastructure prête, CRUD campagnes à ajouter plus tard.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const AD_FREQUENCY        = 10;     // 1 ad tous les N tweets organiques
const MAX_ADS_PER_FEED    = 5;      // Max 5 ads par page de feed
const MIN_MATCH_SCORE     = 0.3;    // Score minimum pour afficher une ad

// ─────────────────────────────────────────────────────────────────────────────
//  TARGETING DB ACCESS
// ─────────────────────────────────────────────────────────────────────────────

let _targetingDB = null;

/**
 * Charge la connexion au module targeting de façon lazy.
 */
function getTargetingDB() {
  if (_targetingDB) return _targetingDB;

  try {
    const targeting = require(path.resolve(__dirname, '../../../../targeting'));
    if (targeting.targetingService) {
      _targetingDB = targeting;
      return _targetingDB;
    }
  } catch (err) {
    // Targeting module pas disponible → non-critique
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════

class AdTargetingEngine {

  constructor() {
    /** @type {Map<string, Object>} campaignId → campaign config */
    this.campaigns = new Map();

    /** @type {Map<string, Object>} userId → targeting profile (cache) */
    this.profileCache = new Map();
    this.profileCacheTTL = 10 * 60 * 1000; // 10 min

    this.stats = {
      totalMatches: 0,
      totalImpressions: 0,
      avgMatchMs: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GESTION DES CAMPAGNES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enregistre ou met à jour une campagne publicitaire.
   *
   * @param {Object} campaign
   * @param {string} campaign.id
   * @param {string} campaign.advertiserId
   * @param {string} campaign.name
   * @param {Object} campaign.creative - { content, mediaUrls, callToAction }
   * @param {Object} campaign.targeting - Critères de ciblage
   *   Exemples :
   *     { user_pays: ['france', 'belgique'] }              → users FR ou BE
   *     { user_tranche_age: ['18_24', '25_34'] }           → 18-34 ans
   *     { user_langue: ['francais'], user_sexe: ['homme'] } → hommes francophones
   *     { user_interessse_developpement_perso: ['true'] }  → intéressés dev perso
   * @param {number} campaign.budget
   * @param {number} campaign.bid         - CPM ou CPC
   * @param {string} campaign.status      - 'active' | 'paused' | 'completed'
   * @param {Date}   campaign.startDate
   * @param {Date}   campaign.endDate
   */
  registerCampaign(campaign) {
    this.campaigns.set(campaign.id, {
      ...campaign,
      impressions: 0,
      clicks: 0,
      spent: 0,
      registeredAt: new Date(),
    });
    console.log(`📢 [AdEngine] Campagne enregistrée: ${campaign.name} (${campaign.id})`);
  }

  /**
   * Supprime une campagne.
   */
  removeCampaign(campaignId) {
    return this.campaigns.delete(campaignId);
  }

  /**
   * Liste toutes les campagnes actives.
   */
  getActiveCampaigns() {
    const now = new Date();
    return [...this.campaigns.values()].filter(c =>
      c.status === 'active' &&
      (!c.startDate || new Date(c.startDate) <= now) &&
      (!c.endDate || new Date(c.endDate) >= now) &&
      c.spent < c.budget
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PROFIL TARGETING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Récupère le profil targeting d'un utilisateur.
   * Cache avec TTL pour éviter les I/O SQLite à chaque requête.
   *
   * @param {string} userId
   * @returns {Object} { group_name: group_value, ... }
   */
  getUserTargetingProfile(userId) {
    // Check cache
    const cached = this.profileCache.get(userId);
    if (cached && (Date.now() - cached.ts) < this.profileCacheTTL) {
      return cached.profile;
    }

    let profile = {};

    try {
      const targeting = getTargetingDB();
      if (targeting && targeting.targetingService) {
        profile = targeting.targetingService.getUserGroups(userId);
      }
    } catch (err) {
      // Non-critique
    }

    this.profileCache.set(userId, { profile, ts: Date.now() });
    return profile;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MATCHING — Score d'une campagne pour un utilisateur
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calcule le score de match entre une campagne et un profil utilisateur.
   *
   * Score = (critères matchés / critères totaux)
   *
   * Un critère est « matché » si :
   *   - Le user a le groupe correspondant
   *   - ET la valeur est dans la liste des valeurs acceptées par la campagne
   *
   * @param {Object} campaign
   * @param {Object} userProfile - { group_name: group_value }
   * @returns {number} score entre 0 et 1
   */
  matchScore(campaign, userProfile) {
    const criteria = campaign.targeting;
    if (!criteria || typeof criteria !== 'object') return 0;

    const criteriaKeys = Object.keys(criteria);
    if (criteriaKeys.length === 0) return 1.0; // Pas de critère = tout le monde

    let matched = 0;
    let total = criteriaKeys.length;

    for (const [groupName, acceptedValues] of Object.entries(criteria)) {
      const userValue = userProfile[groupName];
      if (!userValue) continue;

      const acceptedArr = Array.isArray(acceptedValues) ? acceptedValues : [acceptedValues];

      // Match exact ou match partiel (valeur incluse)
      if (acceptedArr.some(v =>
        String(v).toLowerCase() === String(userValue).toLowerCase()
      )) {
        matched++;
      }
    }

    return matched / total;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SÉLECTION D'ADS POUR UN FEED
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sélectionne les meilleures ads pour un utilisateur.
   *
   * @param {string} userId
   * @param {number} feedLength  - nombre de tweets organiques dans le feed
   * @returns {Array<{position: number, campaign: Object, matchScore: number}>}
   */
  selectAdsForFeed(userId, feedLength = 50) {
    const t0 = Date.now();

    const userProfile = this.getUserTargetingProfile(userId);
    const activeCampaigns = this.getActiveCampaigns();

    if (activeCampaigns.length === 0) {
      return [];
    }

    // Scorer toutes les campagnes actives
    const scored = activeCampaigns.map(campaign => ({
      campaign,
      matchScore: this.matchScore(campaign, userProfile),
    })).filter(s => s.matchScore >= MIN_MATCH_SCORE);

    // Trier par score décroissant × bid
    scored.sort((a, b) =>
      (b.matchScore * b.campaign.bid) - (a.matchScore * a.campaign.bid)
    );

    // Placer les ads dans le feed
    const maxAds = Math.min(
      MAX_ADS_PER_FEED,
      Math.floor(feedLength / AD_FREQUENCY),
      scored.length
    );

    const placements = [];
    for (let i = 0; i < maxAds; i++) {
      placements.push({
        position: (i + 1) * AD_FREQUENCY - 1, // Position dans le feed
        campaign: scored[i].campaign,
        matchScore: scored[i].matchScore,
      });
    }

    const elapsed = Date.now() - t0;
    this.stats.totalMatches++;
    this.stats.avgMatchMs =
      (this.stats.avgMatchMs * (this.stats.totalMatches - 1) + elapsed) / this.stats.totalMatches;

    return placements;
  }

  /**
   * Enregistre une impression d'ad.
   */
  recordImpression(campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (campaign) {
      campaign.impressions++;
      this.stats.totalImpressions++;
    }
  }

  /**
   * Enregistre un clic sur une ad.
   */
  recordClick(campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (campaign) {
      campaign.clicks++;
    }
  }

  /**
   * Retourne les statistiques.
   */
  getStats() {
    return {
      engine: 'AdTargetingEngine',
      activeCampaigns: this.getActiveCampaigns().length,
      totalCampaigns: this.campaigns.size,
      profileCacheSize: this.profileCache.size,
      ...this.stats,
    };
  }
}

module.exports = { AdTargetingEngine };
