'use strict';

const {
  BACKFILL_KEY,
  runSubscriberTweetCreditBackfill,
} = require('../subscriberTweetCreditBackfill');

function fakeSequelize(queryResults) {
  const transaction = { id: 'transaction-1' };
  return {
    transaction: jest.fn(async (callback) => callback(transaction)),
    query: jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(queryResults.marker)
      .mockResolvedValueOnce(queryResults.users || []),
    transactionObject: transaction,
  };
}

describe('subscriber tweet credit backfill', () => {
  test('porte une seule fois les abonnés actifs sous le seuil à cinq crédits', async () => {
    const sequelize = fakeSequelize({
      marker: [{ backfill_key: BACKFILL_KEY }],
      users: [{ id: 'user-1' }, { id: 'user-2' }],
    });

    const result = await runSubscriberTweetCreditBackfill(sequelize);

    expect(result).toEqual({ applied: true, credited: 2 });
    expect(sequelize.query).toHaveBeenCalledTimes(3);
    const updateCall = sequelize.query.mock.calls[2];
    expect(updateCall[0]).toContain("subscription_tier IN ('plus', 'pro')");
    expect(updateCall[0]).toContain('subscription_expires_at > NOW()');
    expect(updateCall[0]).toContain('COALESCE(tweet_generation_credits, 0) < :minimumCredits');
    expect(updateCall[1]).toMatchObject({
      replacements: { minimumCredits: 5 },
      transaction: sequelize.transactionObject,
    });
  });

  test('ne recrédite personne quand le marqueur existe déjà', async () => {
    const sequelize = fakeSequelize({ marker: [] });

    const result = await runSubscriberTweetCreditBackfill(sequelize);

    expect(result).toEqual({ applied: false, credited: 0 });
    expect(sequelize.query).toHaveBeenCalledTimes(2);
  });
});
