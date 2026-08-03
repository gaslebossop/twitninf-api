'use strict';

const {
  extractFeatures,
  buildPrediction,
  fitTargetEnsemble,
  prepareHistory,
} = require('../predictiveModelEngine');

function buildHistory(count = 60) {
  const anchor = new Date('2026-08-01T12:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, index) => {
    const hasMedia = index % 3 === 0;
    const evening = index % 2 === 0;
    const createdAt = new Date(anchor - (index + 3) * 18 * 3600000);
    createdAt.setUTCHours(evening ? 20 : 8, 0, 0, 0);
    const signal = 5 + (hasMedia ? 12 : 0) + (evening ? 9 : 0) + (index % 5);
    const likes = signal;
    const retweets = Math.round(signal * 0.22);
    const replies = Math.round(signal * 0.3);
    return {
      id: `tweet-${index}`,
      content: hasMedia
        ? 'Une idée concrète pour vous. Vous en pensez quoi ? #creation'
        : 'Journal de bord de mon projet et de son évolution',
      createdAt,
      mediaCount: hasMedia ? 1 : 0,
      views: signal * 20,
      clicks: hasMedia ? 4 : 1,
      likes,
      retweets,
      replies,
      engagement: likes + retweets + replies,
      trackedViews: signal * 8,
      bookmarks: hasMedia ? 2 : 0,
      shares: hasMedia ? 2 : 1,
    };
  });
}

describe('predictiveModelEngine', () => {
  test('extrait des signaux textuels continus et pas seulement des booléens', () => {
    const features = extractFeatures(
      '3 idées INCROYABLES pour vous !\nVous en pensez quoi ? #Création @ami https://exemple.test 🚀',
      { mediaCount: 2, publishAt: new Date('2026-08-03T20:00:00.000Z') },
    );

    expect(features.words).toBeGreaterThan(8);
    expect(features.lexicalDiversity).toBeGreaterThan(0);
    expect(features.readabilityScore).toBeGreaterThanOrEqual(0);
    expect(features.hookStrength).toBeGreaterThan(30);
    expect(features.hashtagCount).toBe(1);
    expect(features.mentionCount).toBe(1);
    expect(features.urlCount).toBe(1);
    expect(features.emojiCount).toBe(1);
    expect(features.questionCount).toBe(1);
    expect(features.mediaCount).toBe(2);
    expect(features.topicTokens).toEqual(expect.any(Array));
  });

  test('produit un ensemble calibré complet et des intervalles ordonnés', () => {
    const history = buildHistory();
    const result = buildPrediction({
      history,
      content: 'Une idée concrète pour vous : vous en pensez quoi ? #creation',
      mediaCount: 1,
      publishAt: new Date('2026-08-03T20:00:00.000Z'),
      audienceActivity: [{ dayOfWeek: 1, hour: 20, interactions: 180 }],
      authorContext: { followers: 800, following: 120, verified: true, accountAgeDays: 700 },
    });

    expect(result.hasEnoughData).toBe(true);
    expect(result.model.method).toBeUndefined();
    expect(result.method).toBe('temporal-calibrated-ensemble');
    expect(result.model.featuresConsidered).toBeGreaterThan(30);
    expect(result.model.backtest.holdoutSize).toBeGreaterThanOrEqual(3);
    expect(result.prediction.engagement.low).toBeLessThanOrEqual(result.prediction.engagement.expected);
    expect(result.prediction.engagement.expected).toBeLessThanOrEqual(result.prediction.engagement.high);
    expect(result.prediction.engagement.interval95.low).toBeLessThanOrEqual(
      result.prediction.engagement.interval95.high,
    );
    expect(result.prediction.components.likes.expected).toBeGreaterThanOrEqual(0);
    expect(result.probabilities.top10Percent).toBeGreaterThanOrEqual(0);
    expect(result.probabilities.top10Percent).toBeLessThanOrEqual(100);
    expect(result.timingForecast).toHaveLength(5);
    expect(result.drivers.length).toBeGreaterThan(0);
  });

  test('la régression et les voisins restent finis avec des variables corrélées', () => {
    const rows = prepareHistory(buildHistory(35), new Date('2026-08-03T12:00:00.000Z'));
    const model = fitTargetEnsemble(rows, 'adjustedEngagement');
    const prediction = model.predict(rows[0].features);

    expect(Number.isFinite(prediction.expected)).toBe(true);
    expect(prediction.expected).toBeGreaterThanOrEqual(0);
    expect(Object.values(model.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8);
  });

  test('refuse une précision artificielle avec trop peu de tweets', () => {
    const result = buildPrediction({
      history: buildHistory(3),
      content: 'Un brouillon',
      publishAt: new Date('2026-08-03T12:00:00.000Z'),
    });

    expect(result.hasEnoughData).toBe(false);
    expect(result.minimumRequired).toBe(5);
    expect(result.prediction).toBeUndefined();
  });
});
