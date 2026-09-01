'use strict';

/**
 * Les résolveurs qui relisent la base : ils portent la règle « Ultra d'abord,
 * abonné ensuite », et le repli en cas de lecture impossible.
 *
 * Le repli est la partie qu'on n'a qu'une seule occasion d'écrire
 * correctement : une erreur de lecture du palier ne doit JAMAIS offrir
 * l'avantage payant. C'est vérifié ici pour chacun des deux points d'entrée.
 */

const mockFindByPk = jest.fn();
jest.mock('../../models', () => ({ User: { findByPk: (...a) => mockFindByPk(...a) } }));
jest.mock('../logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { isUltraRequest, ultraLimit } = require('../ultraGate');
const {
  resolveTweetCharLimit,
  TWEET_MAX_CHARS_ULTRA,
  TWEET_MAX_CHARS_SUBSCRIBER,
  TWEET_MAX_CHARS_DEFAULT,
} = require('../tweetLimits');

const FUTURE = new Date(Date.now() + 86400000);
const PAST = new Date(Date.now() - 86400000);

beforeEach(() => mockFindByPk.mockReset());

describe('isUltraRequest', () => {
  test('un Ultra actif en base passe', async () => {
    mockFindByPk.mockResolvedValue({ subscription_tier: 'ultra', subscription_expires_at: FUTURE });
    await expect(isUltraRequest({ id: 'u1' })).resolves.toBe(true);
  });

  test('le jeton ne suffit pas : c\'est la DATE en base qui tranche', async () => {
    // Le jeton dit « ultra » ; la base dit « expiré hier ». C'est la base.
    mockFindByPk.mockResolvedValue({ subscription_tier: 'ultra', subscription_expires_at: PAST });
    await expect(isUltraRequest({ id: 'u1', subscription_tier: 'ultra' })).resolves.toBe(false);
  });

  test('une lecture en échec REFUSE l\'avantage, elle ne l\'offre pas', async () => {
    mockFindByPk.mockRejectedValue(new Error('base injoignable'));
    await expect(isUltraRequest({ id: 'u1', subscription_tier: 'ultra' })).resolves.toBe(false);
  });

  test('sans utilisateur, aucune requête n\'est même tentée', async () => {
    await expect(isUltraRequest(null)).resolves.toBe(false);
    await expect(isUltraRequest({})).resolves.toBe(false);
    expect(mockFindByPk).not.toHaveBeenCalled();
  });
});

describe('ultraLimit', () => {
  test('rend la valeur Ultra à un Ultra, la valeur commune sinon', async () => {
    mockFindByPk.mockResolvedValue({ subscription_tier: 'ultra', subscription_expires_at: FUTURE });
    await expect(ultraLimit({ id: 'u1' }, 20, 5)).resolves.toBe(20);

    mockFindByPk.mockResolvedValue({ subscription_tier: 'pro', subscription_expires_at: FUTURE });
    await expect(ultraLimit({ id: 'u2' }, 20, 5)).resolves.toBe(5);
  });
});

describe('resolveTweetCharLimit', () => {
  test('Ultra est testé AVANT « abonné actif », qu\'il satisfait aussi', async () => {
    // Le piège : un Ultra passe `isSubscriptionActive`. Si l'ordre s'inverse,
    // il repart avec 1 000 caractères au lieu de 2 500, sans aucune erreur.
    mockFindByPk.mockResolvedValue({ subscription_tier: 'ultra', subscription_expires_at: FUTURE });
    await expect(resolveTweetCharLimit({ id: 'u1' })).resolves.toBe(TWEET_MAX_CHARS_ULTRA);
  });

  test('un Pro garde la limite abonné', async () => {
    mockFindByPk.mockResolvedValue({ subscription_tier: 'pro', subscription_expires_at: FUTURE });
    await expect(resolveTweetCharLimit({ id: 'u2' })).resolves.toBe(TWEET_MAX_CHARS_SUBSCRIBER);
  });

  test('un Ultra expiré retombe sur la limite de base', async () => {
    mockFindByPk.mockResolvedValue({ subscription_tier: 'ultra', subscription_expires_at: PAST });
    await expect(resolveTweetCharLimit({ id: 'u3' })).resolves.toBe(TWEET_MAX_CHARS_DEFAULT);
  });

  test('un compte certifié reste sans limite', async () => {
    await expect(resolveTweetCharLimit({ id: 'u4', verified: true })).resolves.toBe(Infinity);
  });

  test('une lecture en échec retombe sur la limite de base', async () => {
    mockFindByPk.mockRejectedValue(new Error('base injoignable'));
    await expect(resolveTweetCharLimit({ id: 'u5' })).resolves.toBe(TWEET_MAX_CHARS_DEFAULT);
  });
});
