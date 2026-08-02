'use strict';

jest.mock('../policiercongo/codexClient', () => ({
  generateWithCodex: jest.fn(),
}));

const { generateWithCodex } = require('../policiercongo/codexClient');
const {
  adjudicate,
  applyHardRules,
} = require('../communityReviewAdjudicator');
const {
  normalizeSanctionDecision,
  MIN_TEMPORARY_BAN_DAYS,
  MAX_TEMPORARY_BAN_DAYS,
} = require('../../config/reviewSanctions');

describe('communityReviewAdjudicator', () => {
  beforeEach(() => {
    generateWithCodex.mockReset();
  });

  test('conserve la durée exacte choisie pour une suspension valide', async () => {
    generateWithCodex.mockResolvedValueOnce(JSON.stringify({
      sanction: 'suspend',
      duration_days: 13,
      motif: 'harassment',
      raison: 'Harcèlement ciblé et répété.',
    }));

    await expect(adjudicate({ content: 'Message ciblé' })).resolves.toMatchObject({
      sanction: 'suspend',
      duration_days: 13,
      motif: 'harassment',
      fallback: false,
    });
  });

  test('refuse none et retombe au minimum sur la suppression', async () => {
    const forbiddenDecision = JSON.stringify({
      sanction: 'none',
      duration_days: null,
      motif: 'other',
      raison: 'Aucune sanction.',
    });
    generateWithCodex
      .mockResolvedValueOnce(forbiddenDecision)
      .mockResolvedValueOnce(forbiddenDecision);

    await expect(adjudicate({ content: 'Message jugé non conforme' })).resolves.toMatchObject({
      sanction: 'delete',
      duration_days: null,
      fallback: true,
    });
  });

  test('les règles fermes protègent self_harm et imposent le ban pour child_safety', () => {
    expect(applyHardRules(
      { sanction: 'suspend', duration_days: 30 },
      'self_harm',
    )).toMatchObject({ sanction: 'delete', duration_days: null });

    expect(applyHardRules(
      { sanction: 'delete', duration_days: null },
      'child_safety',
    )).toMatchObject({ sanction: 'ban_definitif', duration_days: null });
  });

  test('rejette les durées temporaires absentes ou hors limites', () => {
    expect(normalizeSanctionDecision({ sanction: 'suspend' })).toBeNull();
    expect(normalizeSanctionDecision({
      sanction: 'suspend',
      duration_days: MIN_TEMPORARY_BAN_DAYS - 1,
    })).toBeNull();
    expect(normalizeSanctionDecision({
      sanction: 'suspend',
      duration_days: MAX_TEMPORARY_BAN_DAYS + 1,
    })).toBeNull();
  });
});
