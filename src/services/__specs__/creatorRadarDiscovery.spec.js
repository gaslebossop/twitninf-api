'use strict';

const mockQuery = jest.fn();

jest.mock('../../models', () => ({
  Tweet: { findAll: jest.fn() },
  TweetVelocityAlert: {},
  Notification: {},
}));
jest.mock('../../database/index', () => ({
  sequelize: {
    QueryTypes: { SELECT: 'SELECT' },
  },
}));
jest.mock('../../database/readReplica', () => ({
  queryRead: mockQuery,
}));

const { risingAccounts, nicheTrendingTweets } = require('../creatorRadarService');

describe('creator radar discovery', () => {
  beforeEach(() => mockQuery.mockReset());

  test('le radar accepte un gain réel unique et exclut les données de test', async () => {
    mockQuery.mockResolvedValue([{
      id: 'user-2',
      username: 'createur',
      new_followers: 1,
      total_followers: 4,
      common_follows: 1,
      growth_rate: '0.1',
      is_following: true,
    }]);

    const result = await risingAccounts('user-1', { days: 7, limit: 10 });
    const sql = mockQuery.mock.calls[0][0];

    expect(sql).toContain('HAVING COUNT(*) >= 1');
    expect(sql).toContain('is_data_test');
    expect(result[0]).toMatchObject({ new_followers: 1, is_following: true, growth_rate: 0.1 });
  });

  test('les tweets de niche sont mappés sans contenu privé ou payant', async () => {
    mockQuery.mockResolvedValue([{
      id: 'tweet-1',
      content: 'Un signal qui monte',
      created_at: new Date('2026-08-04T00:00:00Z'),
      media_urls: [],
      hashtags: ['#signal'],
      author_id: 'user-2',
      username: 'createur',
      full_name: 'Créateur',
      verified: false,
      premium: true,
      likes: '2',
      retweets: '1',
      replies: '1',
      engagements: '4',
      velocity_ratio: '3.27',
      niche_affinity: '0.8',
      age_hours: '6.4',
      reasons: ['network_affinity', 'fast_engagement'],
    }]);

    const result = await nicheTrendingTweets('user-1', { days: 7, limit: 5 });
    const sql = mockQuery.mock.calls[0][0];

    expect(sql).toContain("pc.content_type = 'tweet'");
    expect(sql).toContain('t.is_private = false');
    expect(sql).toContain('is_data_test');
    expect(result[0]).toMatchObject({
      engagements: 4,
      velocity_ratio: 3.3,
      niche_affinity: 0.8,
      window_hours: 6,
      tweet: { id: 'tweet-1', author: { username: 'createur' } },
    });
  });
});
