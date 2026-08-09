'use strict';

/**
 * La durée d'un abonnement est la seule pièce du modèle payant qui peut
 * déraper sans que rien n'échoue : l'achat réussit, l'utilisateur est premium,
 * et personne ne voit qu'il l'est six fois trop longtemps. Ces tests fixent la
 * règle : la période vendue est `DEFAULT_DURATION_DAYS`, quoi qu'on passe au
 * calcul.
 */

const {
  computeNewExpiry,
  isSubscriptionActive,
  maybeExpireSubscription,
  DEFAULT_DURATION_DAYS,
  TIER,
} = require('../subscriptionHelpers');

const DAY_MS = 86400000;

/** Nombre de jours entre maintenant et une date, arrondi au plus proche. */
function daysFromNow(date) {
  return Math.round((new Date(date).getTime() - Date.now()) / DAY_MS);
}

describe('computeNewExpiry', () => {
  test('une durée absente retombe sur la période standard, pas sur un mois', () => {
    const expiry = computeNewExpiry({ subscription_expires_at: null }, undefined);
    expect(daysFromNow(expiry)).toBe(DEFAULT_DURATION_DAYS);
  });

  test('une durée illisible retombe aussi sur la période standard', () => {
    expect(daysFromNow(computeNewExpiry({}, 'abc'))).toBe(DEFAULT_DURATION_DAYS);
    expect(daysFromNow(computeNewExpiry({}, 0))).toBe(DEFAULT_DURATION_DAYS);
    expect(daysFromNow(computeNewExpiry({}, null))).toBe(DEFAULT_DURATION_DAYS);
  });

  test('un renouvellement prolonge depuis la fin en cours, sans la perdre', () => {
    const user = {
      subscription_tier: TIER.PRO,
      subscription_expires_at: new Date(Date.now() + 2 * DAY_MS),
    };
    const expiry = computeNewExpiry(user, DEFAULT_DURATION_DAYS);
    expect(daysFromNow(expiry)).toBe(2 + DEFAULT_DURATION_DAYS);
  });

  test('une échéance déjà passée repart de maintenant', () => {
    const user = {
      subscription_tier: TIER.PRO,
      subscription_expires_at: new Date(Date.now() - 30 * DAY_MS),
    };
    expect(daysFromNow(computeNewExpiry(user, DEFAULT_DURATION_DAYS))).toBe(DEFAULT_DURATION_DAYS);
  });

  test('une date future sur un compte coupé ne se rachète pas', () => {
    // Compte repassé en gratuit alors qu'il lui « restait » trois semaines :
    // le rachat doit donner la période standard, pas trois semaines de plus.
    const user = {
      subscription_tier: TIER.FREE,
      subscription_expires_at: new Date(Date.now() + 21 * DAY_MS),
    };
    expect(daysFromNow(computeNewExpiry(user, DEFAULT_DURATION_DAYS))).toBe(DEFAULT_DURATION_DAYS);
  });
});

describe('isSubscriptionActive', () => {
  test('un abonnement échu n\'est plus actif', () => {
    expect(isSubscriptionActive({
      subscription_tier: TIER.PRO,
      subscription_expires_at: new Date(Date.now() - 1000),
    })).toBe(false);
  });

  test('un abonnement en cours est actif', () => {
    expect(isSubscriptionActive({
      subscription_tier: TIER.PLUS,
      subscription_expires_at: new Date(Date.now() + DAY_MS),
    })).toBe(true);
  });

  test('le palier gratuit n\'est jamais actif, même avec une date future', () => {
    expect(isSubscriptionActive({
      subscription_tier: TIER.FREE,
      subscription_expires_at: new Date(Date.now() + 30 * DAY_MS),
    })).toBe(false);
  });
});

describe('maybeExpireSubscription', () => {
  /** Faux modèle Sequelize : seul `save` nous intéresse ici. */
  function fakeUser(fields) {
    return { ...fields, saved: false, async save() { this.saved = true; } };
  }

  test('repasse en gratuit ET retire le drapeau premium', async () => {
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() - DAY_MS),
    });

    await expect(maybeExpireSubscription(user)).resolves.toBe(true);
    expect(user.subscription_tier).toBe(TIER.FREE);
    expect(user.premium).toBe(false);
    expect(user.saved).toBe(true);
  });

  test('ne touche pas à un abonnement encore valide', async () => {
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() + DAY_MS),
    });

    await expect(maybeExpireSubscription(user)).resolves.toBe(false);
    expect(user.premium).toBe(true);
    expect(user.saved).toBe(false);
  });
});
