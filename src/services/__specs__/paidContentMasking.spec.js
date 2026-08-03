'use strict';

/**
 * Le masquage est la seule chose qui sépare un contenu vendu d'un contenu
 * gratuit : ce qui n'est pas masqué ici part en clair dans la réponse HTTP.
 *
 * Ces tests portent sur les FORMES de liste servies par les routes de fil, pas
 * sur l'achat : chaque moteur de recommandation a la sienne, et une forme
 * oubliée est une fuite complète du texte vendu.
 */

const locks = [];
const purchases = [];

jest.mock('../../models', () => ({
  PaidContent: {
    findAll: jest.fn(async ({ where }) => {
      const wanted = where.content_id[Object.getOwnPropertySymbols(where.content_id)[0]]
        || where.content_id.in
        || [];
      const ids = new Set(wanted.map(String));
      return locks.filter((l) => ids.has(String(l.content_id)));
    }),
  },
  ContentPurchase: {
    findAll: jest.fn(async ({ where }) => purchases.filter(
      (p) => String(p.buyer_id) === String(where.buyer_id),
    )),
  },
  Tweet: {},
  Story: {},
  User: {},
  Notification: {},
}));

jest.mock('../../database/index', () => ({ sequelize: { transaction: jest.fn() } }));
jest.mock('../../economy', () => ({
  EconomyLedger: {},
  roundTWC: (v) => Math.round(Number(v) * 100) / 100,
  toAmount: (v) => Number(v) || 0,
}));
jest.mock('../../economy/platformCurrency', () => ({ getPlatformCurrency: jest.fn() }));

const paidContent = require('../paidContentService');

const LOCKED_TEXT = 'Le vrai texte, celui qui se vend.';

function lockOn(contentId, extra = {}) {
  return {
    id: `lock-${contentId}`,
    content_type: 'tweet',
    content_id: contentId,
    creator_id: 'creator-1',
    price_twc: 50,
    preview_text: null,
    is_active: true,
    purchases_count: 0,
    net_twc: 0,
    created_at: new Date(0).toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  locks.length = 0;
  purchases.length = 0;
});

describe('maskTweets — formes de liste servies par les routes', () => {
  test('masque un tweet nu et joint le verrou', async () => {
    locks.push(lockOn('t1'));
    const feed = [{ id: 't1', content: LOCKED_TEXT, media_urls: ['/storage/a.jpg'] }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].content).not.toContain('vend');
    expect(feed[0].content).toHaveLength(LOCKED_TEXT.length);
    expect(feed[0].is_locked).toBe(true);
    expect(feed[0].media_urls).toEqual([]);
    expect(feed[0].paid_content).toMatchObject({ price_twc: 50, has_access: false });
  });

  test('masque un tweet enveloppé par un moteur de reco ({ tweet, score })', async () => {
    locks.push(lockOn('t2'));
    const feed = [{ score: 0.9, tweet: { id: 't2', content: LOCKED_TEXT } }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].tweet.content).not.toBe(LOCKED_TEXT);
    expect(feed[0].tweet.is_locked).toBe(true);
  });

  test('masque le tweet d\'origine d\'un retweet — sinon retweeter suffit à publier', async () => {
    locks.push(lockOn('t3'));
    const feed = [{
      id: 'rt1',
      content: '',
      is_retweet: true,
      originalTweet: { id: 't3', content: LOCKED_TEXT },
    }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].originalTweet.content).not.toBe(LOCKED_TEXT);
    expect(feed[0].originalTweet.is_locked).toBe(true);
  });

  test('masque le tweet parent affiché en contexte d\'une réponse', async () => {
    locks.push(lockOn('t4'));
    const feed = [{ id: 'r1', content: 'Ma réponse', parentTweet: { id: 't4', content: LOCKED_TEXT } }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].parentTweet.content).not.toBe(LOCKED_TEXT);
    expect(feed[0].content).toBe('Ma réponse');
  });

  test('un acheteur reçoit le texte intact', async () => {
    locks.push(lockOn('t5'));
    purchases.push({ paid_content_id: 'lock-t5', buyer_id: 'viewer-1' });
    const feed = [{ id: 't5', content: LOCKED_TEXT, media_urls: ['/storage/a.jpg'] }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].content).toBe(LOCKED_TEXT);
    expect(feed[0].media_urls).toEqual(['/storage/a.jpg']);
    expect(feed[0].paid_content.has_access).toBe(true);
  });

  test('le créateur voit son propre contenu', async () => {
    locks.push(lockOn('t6'));
    const feed = [{ id: 't6', content: LOCKED_TEXT }];

    await paidContent.maskTweets(feed, 'creator-1');

    expect(feed[0].content).toBe(LOCKED_TEXT);
    expect(feed[0].paid_content.is_creator).toBe(true);
  });

  test('un aperçu écrit par le créateur remplace le brouillage', async () => {
    locks.push(lockOn('t7', { preview_text: 'Les trois signaux que je surveille…' }));
    const feed = [{ id: 't7', content: LOCKED_TEXT }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].content).toBe('Les trois signaux que je surveille…');
  });

  test('media_urls garde la forme reçue (chaîne JSON en entrée, chaîne en sortie)', async () => {
    locks.push(lockOn('t8'));
    const feed = [{ id: 't8', content: LOCKED_TEXT, media_urls: JSON.stringify(['/storage/a.jpg']) }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].media_urls).toBe('[]');
  });

  test('une publicité injectée dans le fil n\'est pas traitée comme un tweet', async () => {
    locks.push(lockOn('ad-1'));
    const feed = [{ id: 'ad-1', is_ad: true, content: 'Texte publicitaire' }];

    await paidContent.maskTweets(feed, 'viewer-1');

    expect(feed[0].content).toBe('Texte publicitaire');
    expect(feed[0].is_locked).toBeUndefined();
  });
});

describe('maskTweetsOrFail', () => {
  test('coupe la réponse en 500 plutôt que de servir une liste non masquée', async () => {
    const { PaidContent } = require('../../models');
    PaidContent.findAll.mockRejectedValueOnce(new Error('base indisponible'));

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const feed = [{ id: 't9', content: LOCKED_TEXT }];

    await expect(paidContent.maskTweetsOrFail(feed, 'viewer-1', res)).resolves.toBe(false);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(feed[0].content).toBe(LOCKED_TEXT); // rien n'a été envoyé au client
  });
});
