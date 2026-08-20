'use strict';

/**
 * Le miroir décide de ce qui devient un « temps de lecture réel » aux yeux du
 * pot créateur. Une erreur ici ne casse rien visiblement : elle change
 * simplement le montant versé à tout le monde, sans qu'aucune page ne
 * l'annonce. D'où des tests sur les gardes plutôt que sur le chemin heureux
 * seul.
 *
 * Les trois champs vérifiés à l'écriture (`time_spent`, `'tweet'`,
 * `time_spent_ms`) sont exactement ceux sur lesquels `signals.js` filtre et
 * joint : les changer d'un côté sans l'autre remet le bug d'origine.
 */

jest.mock('../behaviorDataCollector', () => ({ recordUserAction: jest.fn() }));
jest.mock('../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const behaviorCollector = require('../behaviorDataCollector');
const { mirrorDwell, DWELL_CAP_MS } = require('../dwellMirror');

const USER = '11111111-1111-1111-1111-111111111111';
const TWEET = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  behaviorCollector.recordUserAction.mockResolvedValue({});
});

describe('mirrorDwell', () => {
  test('écrit une lecture sous la forme exacte que le pot interroge', async () => {
    const written = await mirrorDwell({
      userId: USER,
      tweetId: TWEET,
      action: 'view',
      dwellMs: 5400,
    });

    expect(written).toBe(true);
    expect(behaviorCollector.recordUserAction).toHaveBeenCalledTimes(1);

    const [userId, actionType, targetId, targetType, context] =
      behaviorCollector.recordUserAction.mock.calls[0];

    expect(userId).toBe(USER);
    expect(actionType).toBe('time_spent');
    expect(targetId).toBe(TWEET);
    expect(targetType).toBe('tweet');
    expect(context.time_spent_ms).toBe(5400);
    expect(context.source).toBe('dwell');
  });

  test('ignore les interactions qui ne portent pas de lecture', async () => {
    for (const action of ['like', 'retweet', 'share', 'skip', 'report']) {
      expect(await mirrorDwell({ userId: USER, tweetId: TWEET, action, dwellMs: 9000 })).toBe(false);
    }
    expect(behaviorCollector.recordUserAction).not.toHaveBeenCalled();
  });

  test('un passage de moins d’une seconde n’est pas une lecture', async () => {
    expect(await mirrorDwell({ userId: USER, tweetId: TWEET, action: 'view', dwellMs: 400 })).toBe(false);
    expect(await mirrorDwell({ userId: USER, tweetId: TWEET, action: 'view', dwellMs: 999 })).toBe(false);
    expect(behaviorCollector.recordUserAction).not.toHaveBeenCalled();
  });

  test('plafonne un écran resté allumé toute la nuit', async () => {
    await mirrorDwell({ userId: USER, tweetId: TWEET, action: 'view', dwellMs: 8 * 3600 * 1000 });
    const [, , , , context] = behaviorCollector.recordUserAction.mock.calls[0];
    expect(context.time_spent_ms).toBe(DWELL_CAP_MS);
  });

  test('une durée absurde ou absente n’écrit rien', async () => {
    for (const dwellMs of [undefined, null, NaN, Infinity, -3000, 'longtemps']) {
      expect(await mirrorDwell({ userId: USER, tweetId: TWEET, action: 'view', dwellMs })).toBe(false);
    }
    expect(behaviorCollector.recordUserAction).not.toHaveBeenCalled();
  });

  test('sans lecteur ou sans cible, rien n’est écrit', async () => {
    expect(await mirrorDwell({ tweetId: TWEET, action: 'view', dwellMs: 4000 })).toBe(false);
    expect(await mirrorDwell({ userId: USER, action: 'view', dwellMs: 4000 })).toBe(false);
    expect(behaviorCollector.recordUserAction).not.toHaveBeenCalled();
  });

  test('conserve la nature du contenu, qui rend la durée interprétable', async () => {
    await mirrorDwell({
      userId: USER,
      tweetId: TWEET,
      action: 'view',
      dwellMs: 12000,
      context: { media: 'video', contentChars: 180, videoDurationMs: 30000 },
    });
    const [, , , , context] = behaviorCollector.recordUserAction.mock.calls[0];
    expect(context.media).toBe('video');
    expect(context.contentChars).toBe(180);
    expect(context.videoDurationMs).toBe(30000);
    expect(context.time_spent_ms).toBe(12000);
  });

  test('une panne d’écriture ne remonte pas : le classement ne doit pas tomber avec', async () => {
    behaviorCollector.recordUserAction.mockRejectedValue(new Error('base indisponible'));
    await expect(
      mirrorDwell({ userId: USER, tweetId: TWEET, action: 'view', dwellMs: 4000 }),
    ).resolves.toBe(false);
  });

  test('un identifiant numérique est normalisé en chaîne', async () => {
    await mirrorDwell({ userId: USER, tweetId: 4821, action: 'view', dwellMs: 3000 });
    const [, , targetId] = behaviorCollector.recordUserAction.mock.calls[0];
    expect(targetId).toBe('4821');
  });
});
