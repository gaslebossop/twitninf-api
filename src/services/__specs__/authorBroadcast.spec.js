const {
  broadcastNewTweet,
  sanitizeMessage,
  defaultMessage,
  MESSAGE_MAX,
  MAX_RECIPIENTS,
  KIND,
} = require('../authorBroadcastService');

jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: {} }) }));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

/**
 * Ce que ces tests protègent : notifier tous ses abonnés est un mégaphone.
 * Les garde-fous (palier, abonnement échu, fenêtre anti-spam, plafond) sont
 * invisibles à l'usage — on ne s'aperçoit qu'ils ont sauté que lorsque des
 * milliers de gens ont déjà reçu la notification de trop.
 */

const ULTRA = {
  id: 'author-1',
  username: 'kospor',
  subscription_tier: 'ultra',
  subscription_expires_at: null,
};

/** Modèles factices : on vérifie les règles, pas Sequelize. */
function makeModels({ author = ULTRA, followers = ['f1', 'f2'], lastBroadcast = null } = {}) {
  const created = [];
  return {
    created,
    models: {
      User: {
        findByPk: jest.fn().mockResolvedValue(author),
        findAll: jest.fn().mockResolvedValue([]),
      },
      UserFollow: {
        findAll: jest.fn().mockImplementation(({ limit }) =>
          Promise.resolve(followers.slice(0, limit).map((id) => ({ follower_id: id }))),
        ),
      },
      Notification: {
        findOne: jest.fn().mockResolvedValue(lastBroadcast),
        bulkCreate: jest.fn().mockImplementation((rows) => {
          created.push(...rows);
          return Promise.resolve(rows);
        }),
      },
    },
  };
}

describe('sanitizeMessage', () => {
  it('écrase les retours à la ligne qui casseraient l\'aperçu système', () => {
    expect(sanitizeMessage('deux\n\nlignes')).toBe('deux lignes');
  });

  it('tronque à la longueur annoncée par la validation de la route', () => {
    expect(sanitizeMessage('a'.repeat(400))).toHaveLength(MESSAGE_MAX);
  });

  it('traite le vide et le non-texte comme une absence de message', () => {
    expect(sanitizeMessage('   ')).toBeNull();
    expect(sanitizeMessage(null)).toBeNull();
    expect(sanitizeMessage(42)).toBeNull();
  });
});

describe('broadcastNewTweet — qui a le droit', () => {
  it('refuse un compte qui n\'est pas Ultra', async () => {
    const { models, created } = makeModels({ author: { ...ULTRA, subscription_tier: 'pro' } });
    const result = await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(result).toEqual({ sent: 0, reason: 'not_ultra' });
    expect(created).toHaveLength(0);
  });

  it('refuse un Ultra dont l\'abonnement a expiré', async () => {
    // Le palier reste écrit en base après expiration : sans cette vérification,
    // l'avantage survivrait à l'abonnement qui le paie.
    const expired = { ...ULTRA, subscription_expires_at: new Date(Date.now() - 1000) };
    const { models, created } = makeModels({ author: expired });
    const result = await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(result.reason).toBe('not_ultra');
    expect(created).toHaveLength(0);
  });

  it('ne fait rien si l\'auteur est introuvable', async () => {
    const { models } = makeModels({ author: null });
    const result = await broadcastNewTweet({ models, authorId: 'nope', tweetId: 't1' });
    expect(result.reason).toBe('author_not_found');
  });
});

describe('broadcastNewTweet — les bornes anti-abus', () => {
  it('saute l\'envoi si une diffusion a déjà eu lieu dans la fenêtre', async () => {
    const { models, created } = makeModels({ lastBroadcast: { id: 'n1' } });
    const result = await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't2' });
    expect(result).toEqual({ sent: 0, reason: 'cooldown' });
    expect(created).toHaveLength(0);
  });

  it('plafonne le nombre de destinataires', async () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 500 }, (_, i) => `f${i}`);
    const { models } = makeModels({ followers: many });
    const result = await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(result.sent).toBe(MAX_RECIPIENTS);
    expect(models.UserFollow.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_RECIPIENTS }),
    );
  });

  it('ne se notifie jamais lui-même', async () => {
    const { models, created } = makeModels({ followers: ['author-1', 'f2'] });
    await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(created.map((r) => r.recipient_id)).toEqual(['f2']);
  });

  it('ne fait rien sans abonné', async () => {
    const { models } = makeModels({ followers: [] });
    const result = await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(result).toEqual({ sent: 0, reason: 'no_followers' });
  });
});

describe('broadcastNewTweet — ce qui est écrit', () => {
  it('écrit en UNE fois, pas une notification par abonné', async () => {
    // `createNotification` fait un appel HTTP à Expo PAR destinataire : s'en
    // servir ici rendrait la publication dépendante de N requêtes réseau.
    const { models } = makeModels({ followers: ['f1', 'f2', 'f3'] });
    await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(models.Notification.bulkCreate).toHaveBeenCalledTimes(1);
  });

  it('reprend le message de l\'auteur', async () => {
    const { models, created } = makeModels();
    await broadcastNewTweet({
      models, authorId: 'author-1', tweetId: 't1', message: '  Nouvel  album  ',
    });
    expect(created[0].message).toBe('Nouvel album');
    expect(created[0].title).toBe('@kospor a publié');
  });

  it('retombe sur un message par défaut si l\'auteur n\'en écrit pas', async () => {
    const { models, created } = makeModels();
    await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1', message: '   ' });
    expect(created[0].message).toBe(defaultMessage('kospor'));
  });

  it('réutilise le type `system` et se distingue par metadata.kind', async () => {
    // `Notification.type` est un ENUM Postgres et `migrate.js` n'est jamais
    // joué au démarrage : une nouvelle valeur ferait échouer toute insertion
    // en production. Même contournement que les demandes de suivi.
    const { models, created } = makeModels();
    await broadcastNewTweet({ models, authorId: 'author-1', tweetId: 't1' });
    expect(created[0].type).toBe('system');
    expect(created[0].metadata).toEqual({ kind: KIND });
    expect(created[0].tweet_id).toBe('t1');
    expect(created[0].sender_id).toBe('author-1');
  });
});
