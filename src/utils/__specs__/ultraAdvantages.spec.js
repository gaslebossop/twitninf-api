'use strict';

/**
 * Les avantages Ultra sont des PLAFONDS, et un plafond se trompe en silence :
 * l'appel réussit, personne ne voit qu'il a rendu la valeur du palier d'en
 * dessous — ou, bien pire, celle du palier du dessus à quelqu'un qui n'a pas
 * payé. Ces tests fixent les deux règles qui comptent :
 *
 *  1. un Ultra EXPIRÉ ne garde aucun avantage ;
 *  2. Ultra passe toujours AVANT le test « abonné actif », qu'il satisfait
 *     aussi — l'ordre inverse lui rendrait la valeur Plus/Pro.
 */

const { isUltraActive, TIER } = require('../subscriptionHelpers');
const { SUPER_HEART_CAPS } = require('../superHeartHelpers');
const {
  TWEET_MAX_CHARS_ULTRA,
  TWEET_MAX_CHARS_SUBSCRIBER,
  TWEET_MAX_CHARS_DEFAULT,
} = require('../tweetLimits');
const {
  P2P_TRANSFER_FEE_RATE,
  P2P_TRANSFER_FEE_RATE_SUBSCRIBER,
  P2P_TRANSFER_FEE_RATE_ULTRA,
} = require('../../economy/constants');
const {
  PLATFORM_CONTENT_FEE_RATE,
  PLATFORM_CONTENT_FEE_RATE_ULTRA,
  PLATFORM_USERNAME_FEE_RATE,
  PLATFORM_USERNAME_FEE_RATE_ULTRA,
  PROFILE_VIEW_WINDOW_DAYS,
  PROFILE_VIEW_WINDOW_DAYS_ULTRA,
  PROFILE_VIEW_RETENTION_DAYS,
  TWEET_EDIT_MAX_REVISIONS,
  TWEET_EDIT_MAX_REVISIONS_ULTRA,
  SCHEDULE_MAX_HORIZON_DAYS,
  SCHEDULE_MAX_HORIZON_DAYS_ULTRA,
  SCHEDULE_MAX_PENDING,
  SCHEDULE_MAX_PENDING_ULTRA,
  USERNAME_RESERVATION_MAX_PER_USER,
  USERNAME_RESERVATION_MAX_PER_USER_ULTRA,
} = require('../../constants/premiumMarket');

const DAY_MS = 86400000;
const ultra = (offsetDays) => ({
  subscription_tier: TIER.ULTRA,
  subscription_expires_at: new Date(Date.now() + offsetDays * DAY_MS),
});

describe('isUltraActive', () => {
  test('un Ultra encore abonné est reconnu', () => {
    expect(isUltraActive(ultra(3))).toBe(true);
  });

  test('un Ultra sans date de fin est reconnu (abonnement sans terme)', () => {
    expect(isUltraActive({ subscription_tier: TIER.ULTRA, subscription_expires_at: null })).toBe(true);
  });

  test('un Ultra EXPIRÉ ne l\'est plus — c\'est tout l\'intérêt du test', () => {
    expect(isUltraActive(ultra(-1))).toBe(false);
  });

  test('les paliers en dessous ne passent jamais pour de l\'Ultra', () => {
    expect(isUltraActive({ subscription_tier: TIER.PRO, subscription_expires_at: null })).toBe(false);
    expect(isUltraActive({ subscription_tier: TIER.PLUS, subscription_expires_at: null })).toBe(false);
    expect(isUltraActive({ subscription_tier: TIER.FREE })).toBe(false);
  });

  test('une entrée absente ou vide ne donne aucun avantage', () => {
    expect(isUltraActive(null)).toBe(false);
    expect(isUltraActive(undefined)).toBe(false);
    expect(isUltraActive({})).toBe(false);
  });
});

describe('Ultra est strictement au-dessus du palier en dessous', () => {
  test('Super Coeurs : Ultra ne reprend plus le plafond Pro', () => {
    expect(SUPER_HEART_CAPS[TIER.ULTRA]).toBeGreaterThan(SUPER_HEART_CAPS[TIER.PRO]);
  });

  test('longueur de tweet : Ultra > abonné > défaut', () => {
    expect(TWEET_MAX_CHARS_ULTRA).toBeGreaterThan(TWEET_MAX_CHARS_SUBSCRIBER);
    expect(TWEET_MAX_CHARS_SUBSCRIBER).toBeGreaterThan(TWEET_MAX_CHARS_DEFAULT);
  });

  test('commission de virement : Ultra ne paie rien, et les autres paient plus', () => {
    expect(P2P_TRANSFER_FEE_RATE_ULTRA).toBe(0);
    expect(P2P_TRANSFER_FEE_RATE_SUBSCRIBER).toBeGreaterThan(P2P_TRANSFER_FEE_RATE_ULTRA);
    expect(P2P_TRANSFER_FEE_RATE).toBeGreaterThan(P2P_TRANSFER_FEE_RATE_SUBSCRIBER);
  });

  test('commissions de vente : la remise Ultra va bien dans le sens du créateur', () => {
    expect(PLATFORM_CONTENT_FEE_RATE_ULTRA).toBeLessThan(PLATFORM_CONTENT_FEE_RATE);
    expect(PLATFORM_USERNAME_FEE_RATE_ULTRA).toBeLessThan(PLATFORM_USERNAME_FEE_RATE);
  });

  test('les plafonds relevés le sont tous dans le bon sens', () => {
    expect(TWEET_EDIT_MAX_REVISIONS_ULTRA).toBeGreaterThan(TWEET_EDIT_MAX_REVISIONS);
    expect(SCHEDULE_MAX_HORIZON_DAYS_ULTRA).toBeGreaterThan(SCHEDULE_MAX_HORIZON_DAYS);
    expect(SCHEDULE_MAX_PENDING_ULTRA).toBeGreaterThan(SCHEDULE_MAX_PENDING);
    expect(USERNAME_RESERVATION_MAX_PER_USER_ULTRA).toBeGreaterThan(USERNAME_RESERVATION_MAX_PER_USER);
    expect(PROFILE_VIEW_WINDOW_DAYS_ULTRA).toBeGreaterThan(PROFILE_VIEW_WINDOW_DAYS);
  });

  test('la fenêtre de visiteurs Ultra ne dépasse PAS ce qui est conservé', () => {
    // Aller au-delà obligerait à garder les visites plus longtemps — donc à
    // collecter plus pour vendre un avantage. C'est la borne à ne pas franchir.
    expect(PROFILE_VIEW_WINDOW_DAYS_ULTRA).toBeLessThanOrEqual(PROFILE_VIEW_RETENTION_DAYS);
  });
});
