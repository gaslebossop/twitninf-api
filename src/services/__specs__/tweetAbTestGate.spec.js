const assert = require('node:assert');

/**
 * Porte d'ÉCRITURE des expériences A/B : qui a le droit d'en lancer une.
 *
 * Jusqu'au 2026-08-31, elle valait `client === 'windows-electron'` — le mobile
 * recevait un 403 sec. Le mobile entre maintenant derrière `fil.abtest`, le
 * MÊME drapeau qui décide, côté lecture, si un lecteur reçoit des variantes
 * (`routes/neuralRankRoutes.js`). Deux drapeaux séparés auraient permis
 * d'écrire un test que personne dans sa propre cohorte ne peut voir.
 *
 * Ce que ces tests verrouillent :
 *   1. Windows passe toujours, drapeau ou pas — c'est la population de test
 *      d'origine, la lui retirer casserait un usage en cours ;
 *   2. le mobile ne passe QUE si le drapeau est levé pour CE lecteur ;
 *   3. le drapeau est interrogé sur `user_id`, pas sur autre chose : un auteur
 *      ne doit pas gagner puis perdre l'accès d'une session à l'autre ;
 *   4. les autres clients restent dehors, drapeau levé ou non — rien n'y
 *      compose de variantes, et une porte ouverte sans interface derrière est
 *      une porte qu'on oublie de refermer ;
 *   5. le refus est un 403 et pas un 400 : c'est une question de droit, pas de
 *      forme de requête.
 */

// Tout ce que le service tire derrière lui est remplacé : on mesure la
// DÉCISION, pas Redis, pas la base, pas Gemini. Sans ces doublures, charger le
// service ouvre un pool Sequelize et le processus de test ne rend jamais la
// main.
const mockEtat = { flagReponse: false, appels: [] };

jest.mock('../featureFlagService', () => ({
  isEnabled: async (key, context) => {
    mockEtat.appels.push({ key, context });
    return mockEtat.flagReponse;
  },
  contextFromRequest: async () => ({ user_id: 'u1', username: 'gas' }),
}));

jest.mock('../../models', () => ({
  sequelize: { query: async () => [[]] },
  User: { findByPk: async () => ({ id: 'u1', verified: true }) },
  UserFollow: { countFollowers: async () => 99 },
}));

jest.mock('../geminiService', () => ({ evaluateTweetForRecommendations: async () => null }));
jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));

const { clientMayAuthor, platformScopeFor, assertEligible, AbTestRequestError } =
  require('../tweetAbTestService');

beforeEach(() => {
  mockEtat.flagReponse = false;
  mockEtat.appels = [];
});

describe('porte d’écriture des expériences A/B', () => {
  test('Windows passe, drapeau levé ou non', async () => {
    mockEtat.flagReponse = false;
    assert.strictEqual(await clientMayAuthor('windows-electron', { user_id: 'u1' }), true);
    mockEtat.flagReponse = true;
    assert.strictEqual(await clientMayAuthor('windows-electron', { user_id: 'u1' }), true);
  });

  test('Windows n’interroge même pas le service de drapeaux', async () => {
    await clientMayAuthor('windows-electron', { user_id: 'u1' });
    assert.strictEqual(mockEtat.appels.length, 0);
  });

  test('le mobile passe avec le drapeau, pas sans', async () => {
    mockEtat.flagReponse = true;
    assert.strictEqual(await clientMayAuthor('mobile-expo', { user_id: 'u1' }), true);
    mockEtat.flagReponse = false;
    assert.strictEqual(await clientMayAuthor('mobile-expo', { user_id: 'u1' }), false);
  });

  test('le drapeau est interrogé sur fil.abtest, pour CE lecteur', async () => {
    mockEtat.flagReponse = true;
    await clientMayAuthor('mobile-expo', { user_id: 'u-42' });
    assert.strictEqual(mockEtat.appels.length, 1);
    assert.strictEqual(mockEtat.appels[0].key, 'fil.abtest');
    assert.deepStrictEqual(mockEtat.appels[0].context, { user_id: 'u-42' });
  });

  /**
   * Le defaut qui s'est reellement produit, le 2026-08-31.
   *
   * La liste d'acces d'un drapeau reconnait un identifiant, un PSEUDO ou un
   * identifiant d'appareil, et l'ecran d'admin y ecrit des pseudos. La porte
   * evaluait le drapeau avec `{ user_id }` seul : l'entree « gas » ne pouvait
   * pas matcher.
   *
   * Le symptome etait trompeur au possible — l'app, qui resout ses drapeaux
   * avec le contexte complet de la requete, AFFICHAIT la puce ; seule la
   * publication repondait « la beta A/B n'est pas ouverte sur ce client ». Un
   * bouton visible qui refuse de marcher.
   *
   * Ce test verifie que le contexte traverse la porte tel quel, pseudo compris.
   */
  test('le contexte traverse la porte en entier, pseudo compris', async () => {
    mockEtat.flagReponse = true;
    const contexte = { user_id: 'u-42', username: 'gas', device_id: 'd-7' };
    await clientMayAuthor('mobile-expo', contexte);
    assert.deepStrictEqual(mockEtat.appels[0].context, contexte);
  });

  test('assertEligible transmet le contexte complet qu’on lui donne', async () => {
    mockEtat.flagReponse = true;
    await assertEligible({
      userId: 'u-42',
      client: 'mobile-expo',
      parentTweetId: null,
      isPrivate: false,
      flagContext: { user_id: 'u-42', username: 'gas' },
    });
    assert.deepStrictEqual(mockEtat.appels[0].context, { user_id: 'u-42', username: 'gas' });
  });

  test('sans contexte fourni, assertEligible retombe sur l’identifiant seul', async () => {
    mockEtat.flagReponse = true;
    await assertEligible({ userId: 'u-9', client: 'mobile-expo', parentTweetId: null, isPrivate: false });
    assert.deepStrictEqual(mockEtat.appels[0].context, { user_id: 'u-9' });
  });

  test('la casse de l’en-tête n’a pas à être exacte', async () => {
    mockEtat.flagReponse = true;
    assert.strictEqual(await clientMayAuthor('MOBILE-EXPO', { user_id: 'u1' }), true);
    assert.strictEqual(await clientMayAuthor('  mobile-expo  ', { user_id: 'u1' }), true);
  });

  test('les autres clients restent dehors, drapeau levé', async () => {
    mockEtat.flagReponse = true;
    for (const client of ['twitninf-web', 'curl/8', '', undefined, null]) {
      assert.strictEqual(await clientMayAuthor(client, { user_id: 'u1' }), false, String(client));
    }
  });

  test('un mobile sans drapeau reçoit un 403, pas un 400', async () => {
    mockEtat.flagReponse = false;
    await assert.rejects(
      () => assertEligible({ userId: 'u1', client: 'mobile-expo', parentTweetId: null, isPrivate: false }),
      (error) => {
        assert.ok(error instanceof AbTestRequestError);
        assert.strictEqual(error.status, 403);
        return true;
      },
    );
  });
});

describe('portée enregistrée avec l’expérience', () => {
  // Rien ne LIT `platform_scope` aujourd'hui — elle documente l'origine. Mais
  // elle était écrite en dur à 'windows', et une colonne qui ment sur la
  // moitié de ses lignes finit par être lue un jour.
  test('elle reflète le client qui a lancé l’expérience', () => {
    assert.strictEqual(platformScopeFor('mobile-expo'), 'mobile');
    assert.strictEqual(platformScopeFor('windows-electron'), 'windows');
    assert.strictEqual(platformScopeFor('MOBILE-EXPO'), 'mobile');
  });

  test('un client inconnu n’est pas rangé au hasard sous « windows »', () => {
    assert.strictEqual(platformScopeFor('twitninf-web'), 'unknown');
    assert.strictEqual(platformScopeFor(undefined), 'unknown');
    assert.strictEqual(platformScopeFor(''), 'unknown');
  });
});
