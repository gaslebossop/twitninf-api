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
const {
  archiveForDowngrade,
  restoreFromArchive,
} = require('../profileCustomization');

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
  /** Faux modèle Sequelize : `save` et `changed` suffisent ici. */
  function fakeUser(fields) {
    return {
      ...fields,
      saved: false,
      async save() { this.saved = true; },
      changed() {},
    };
  }

  const HABILLAGE_PAYANT = {
    accent_color: '#ff00aa',
    banner_style: 'mesh',
    avatar_decoration: 'crown',
    name_font: 'techno',
    name_effect: 'shimmer',
    profile_effect: 'embers',
    profile_title: 'Boss',
  };

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
      verified: false,
      profile_customization: { ...HABILLAGE_PAYANT },
    });

    await expect(maybeExpireSubscription(user)).resolves.toBe(false);
    expect(user.premium).toBe(true);
    expect(user.saved).toBe(false);
    expect(user.profile_customization).toEqual(HABILLAGE_PAYANT);
  });

  test('retire l\'habillage payant, qui sinon reste visible à vie', async () => {
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() - DAY_MS),
      verified: false,
      profile_customization: { ...HABILLAGE_PAYANT },
    });

    await maybeExpireSubscription(user);
    expect(user.profile_customization).toEqual({});
  });

  test('met l\'habillage de côté au lieu de le perdre', async () => {
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() - DAY_MS),
      verified: false,
      profile_customization: { ...HABILLAGE_PAYANT },
    });

    await maybeExpireSubscription(user);
    expect(user.profile_customization_archive).toEqual(HABILLAGE_PAYANT);
  });

  test('un compte certifié garde son effet de nom « Certifié »', async () => {
    // Cet effet suit le badge de vérification, pas l'abonnement.
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() - DAY_MS),
      verified: true,
      profile_customization: { ...HABILLAGE_PAYANT, name_effect: 'certified' },
    });

    await maybeExpireSubscription(user);
    expect(user.profile_customization).toEqual({ name_effect: 'certified' });
  });

  test('n\'écrase pas une personnalisation qui n\'a pas été chargée', async () => {
    // authMiddleware ne charge que les colonnes d'abonnement : écrire ici
    // remplacerait par {} un habillage qu'on n'a jamais lu.
    const user = fakeUser({
      subscription_tier: TIER.PRO,
      premium: true,
      subscription_expires_at: new Date(Date.now() - DAY_MS),
    });

    await maybeExpireSubscription(user);
    expect(user.profile_customization).toBeUndefined();
    expect(user.premium).toBe(false);
  });
});

describe('archive et restitution de l’habillage', () => {
  const HABILLAGE_PRO = {
    accent_color: '#ff00aa',
    banner_style: 'mesh',
    avatar_decoration: 'crown',
    name_font: 'techno',
    name_effect: 'shimmer',
    profile_effect: 'embers',
    name_size: 'giant',
    profile_title: 'Boss',
    about_me: 'salut',
  };

  test('un réabonnement Pro rend l’habillage tel quel', () => {
    const archive = archiveForDowngrade(HABILLAGE_PRO, { verified: false });
    expect(restoreFromArchive(archive, TIER.PRO, { verified: false })).toEqual(HABILLAGE_PRO);
  });

  test('un ancien Pro qui reprend Plus ne récupère que ce que Plus autorise', () => {
    const archive = archiveForDowngrade(HABILLAGE_PRO, { verified: false });
    const rendu = restoreFromArchive(archive, TIER.PLUS, { verified: false });

    // Couleurs, bannière et textes : compris dans Plus.
    expect(rendu.accent_color).toBe('#ff00aa');
    expect(rendu.banner_style).toBe('mesh');
    expect(rendu.profile_title).toBe('Boss');
    // Décorations et habillages animés : exclusifs à Pro.
    expect(rendu.avatar_decoration).toBe('none');
    expect(rendu.name_font).toBe('system');
    expect(rendu.name_effect).toBe('none');
    expect(rendu.profile_effect).toBe('none');
  });

  test('rien à archiver quand il n’y a pas d’habillage payant', () => {
    expect(archiveForDowngrade({}, { verified: false })).toBeNull();
    expect(archiveForDowngrade({ name_effect: 'certified' }, { verified: true })).toBeNull();
  });

  test('une archive absente ne restitue rien', () => {
    expect(restoreFromArchive(null, TIER.PRO, { verified: false })).toBeNull();
    expect(restoreFromArchive({}, TIER.PRO, { verified: false })).toBeNull();
  });
});
