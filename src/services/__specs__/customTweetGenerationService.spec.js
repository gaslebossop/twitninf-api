'use strict';

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockFindByPk = jest.fn();
const mockGenerateText = jest.fn();
const mockParseJsonLoose = jest.fn();
const mockIsAvailable = jest.fn();

const dbTransaction = { LOCK: { NO_KEY_UPDATE: 'NO KEY UPDATE' } };

jest.mock('../../models', () => ({
  sequelize: {
    query: mockQuery,
    transaction: mockTransaction,
    QueryTypes: { SELECT: 'SELECT' },
  },
  User: { findByPk: mockFindByPk },
}));
jest.mock('../codexTextClient', () => ({
  generateText: mockGenerateText,
  parseJsonLoose: mockParseJsonLoose,
  isAvailable: mockIsAvailable,
}));
jest.mock('../aiCopilotService', () => ({ PLATFORM_CONTEXT: 'CONTEXTE TWITNINF' }));

const generator = require('../customTweetGenerationService');

function paidUser(credits = 2) {
  return {
    id: 'user-1',
    premium: true,
    subscription_tier: 'plus',
    subscription_expires_at: new Date(Date.now() + 86400000),
    tweet_generation_credits: credits,
    reload: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockImplementation(async function update(values) {
      Object.assign(this, values);
      return this;
    }),
  };
}

describe('custom tweet generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (callback) => callback(dbTransaction));
    mockQuery.mockResolvedValue([{ content: 'frero ce soir on va tout casser' }]);
    mockIsAvailable.mockResolvedValue(true);
  });

  test('réserve un crédit et rend un brouillon dans le style du compte', async () => {
    const user = paidUser(2);
    mockFindByPk.mockResolvedValue(user);
    mockGenerateText.mockResolvedValue({ success: true, text: '{json}' });
    mockParseJsonLoose.mockReturnValue({ tweet: 'ce soir on lance le bail frero', angle: 'annonce directe' });

    const result = await generator.generateForUser('user-1', 'Annonce notre live de ce soir');

    expect(result).toMatchObject({
      success: true,
      tweet: 'ce soir on lance le bail frero',
      creditsRemaining: 1,
      styleSamples: 1,
    });
    expect(user.update).toHaveBeenCalledWith(
      { tweet_generation_credits: 1 },
      { transaction: dbTransaction },
    );
    expect(mockGenerateText.mock.calls[0][0]).toContain('Annonce notre live de ce soir');
    expect(mockGenerateText.mock.calls[0][0]).toContain('frero ce soir on va tout casser');
  });

  test('rembourse automatiquement une génération invalide', async () => {
    const user = paidUser(1);
    mockFindByPk.mockResolvedValue(user);
    mockGenerateText.mockResolvedValue({ success: true, text: 'réponse cassée' });
    mockParseJsonLoose.mockReturnValue(null);

    const result = await generator.generateForUser('user-1', 'Parle de mon nouveau projet');

    expect(result).toMatchObject({
      success: false,
      error: 'invalid_generation',
      creditsRemaining: 1,
    });
    expect(user.tweet_generation_credits).toBe(1);
    expect(user.update).toHaveBeenCalledTimes(2);
  });

  test('refuse sans crédit avant de lancer Codex', async () => {
    mockFindByPk.mockResolvedValue(paidUser(0));

    const result = await generator.generateForUser('user-1', 'Fais une annonce mystérieuse');

    expect(result).toMatchObject({ success: false, error: 'no_credits', creditsRemaining: 0 });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test('ne consomme rien tant que le compte n’a aucun tweet de référence', async () => {
    mockQuery.mockResolvedValue([]);

    const result = await generator.generateForUser('user-1', 'Fais une annonce mystérieuse');

    expect(result).toMatchObject({ success: false, error: 'no_style_profile' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
