jest.mock('../../models', () => ({
  sequelize: { query: jest.fn(), QueryTypes: { SELECT: 'SELECT' } },
  User: {},
  UserFollow: {},
}));
jest.mock('../geminiService', () => ({ evaluateTweetForRecommendations: jest.fn() }));
jest.mock('../featureFlagService', () => ({ isEnabled: jest.fn() }));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { sequelize } = require('../../models');
const { listAuthorExperiments } = require('../tweetAbTestService');

/**
 * Le piege d'un ecran de test A/B est d'afficher « B : 12 % · A : 8 % » sur
 * vingt impressions. A ce volume l'ecart est du bruit — une interaction de
 * plus fait basculer le classement — mais un pourcentage affiche se lit comme
 * un resultat, et l'auteur ecrit ses tweets suivants en suivant du hasard.
 *
 * Ces tests protegent la seule chose qui empeche ca : un taux n'existe QUE
 * quand le seuil de l'experience est atteint.
 */

const row = (over = {}) => ({
  experiment_id: 'e1',
  tweet_id: 't1',
  status: 'active',
  strategy: 'adaptive',
  platform_scope: 'windows',
  min_impressions_per_variant: 6,
  winner_variant_id: null,
  cancellation_reason: null,
  activated_at: null,
  completed_at: null,
  created_at: '2026-09-01T00:00:00Z',
  variant_id: 'v1',
  position: 0,
  label: 'A',
  content: 'Version A',
  is_control: true,
  moderation_status: 'approved',
  impressions: 10,
  interactions: 2,
  reach: 10,
  ...over,
});

beforeEach(() => sequelize.query.mockReset());

test('regroupe les lignes plates en experiences', async () => {
  sequelize.query.mockResolvedValue([
    row(),
    row({ variant_id: 'v2', position: 1, label: 'B', content: 'Version B', is_control: false }),
  ]);
  const [exp] = await listAuthorExperiments('author-1');
  expect(exp.id).toBe('e1');
  expect(exp.variants.map((v) => v.label)).toEqual(['A', 'B']);
  // Une seule requete : l'ecran se rafraichit au pull-to-refresh, il ne doit
  // pas couter N+1 allers-retours.
  expect(sequelize.query).toHaveBeenCalledTimes(1);
});

test('aucun taux tant que le seuil n\'est pas atteint', async () => {
  sequelize.query.mockResolvedValue([row({ impressions: 3, interactions: 1, reach: 3 })]);
  const [exp] = await listAuthorExperiments('author-1');
  // `null`, pas 0 : un taux absent doit se distinguer d'un taux nul, sinon le
  // client affiche « 0 % » sur une variante qui n'a simplement pas ete vue.
  expect(exp.variants[0].engagement_rate).toBeNull();
  expect(exp.variants[0].sufficient).toBe(false);
  // Les comptes bruts restent la : ils sont vrais a n'importe quel volume.
  expect(exp.variants[0].reach).toBe(3);
  expect(exp.variants[0].interactions).toBe(1);
});

test('le taux apparait une fois le seuil franchi', async () => {
  sequelize.query.mockResolvedValue([row({ reach: 10, impressions: 10, interactions: 2 })]);
  const [exp] = await listAuthorExperiments('author-1');
  // 2 interactions pour 10 EXPOSITIONS.
  expect(exp.variants[0].engagement_rate).toBeCloseTo(0.2);
  expect(exp.variants[0].sufficient).toBe(true);
});

test('l\'experience n\'est comparable que si TOUTES les variantes ont le volume', async () => {
  sequelize.query.mockResolvedValue([
    row({ reach: 10 }),
    row({ variant_id: 'v2', position: 1, label: 'B', reach: 2, interactions: 1 }),
  ]);
  const [exp] = await listAuthorExperiments('author-1');
  // Une variante au-dessus du seuil ne permet aucune COMPARAISON : c'est
  // l'ecart entre elles qui interesse l'auteur, pas un chiffre isole.
  expect(exp.comparable).toBe(false);
});

test('une variante seule n\'est jamais comparable', async () => {
  sequelize.query.mockResolvedValue([row({ reach: 100, interactions: 40 })]);
  const [exp] = await listAuthorExperiments('author-1');
  expect(exp.comparable).toBe(false);
});

test('additionne les totaux de l\'experience', async () => {
  sequelize.query.mockResolvedValue([
    row({ reach: 10, impressions: 10, interactions: 2 }),
    row({ variant_id: 'v2', position: 1, label: 'B', reach: 8, impressions: 8, interactions: 3 }),
  ]);
  const [exp] = await listAuthorExperiments('author-1');
  expect(exp.total_reach).toBe(18);
  expect(exp.total_interactions).toBe(5);
  expect(exp.comparable).toBe(true);
});

test('le seuil vient de l\'experience, pas d\'une constante', async () => {
  sequelize.query.mockResolvedValue([
    row({ min_impressions_per_variant: 50, reach: 20, interactions: 5 }),
  ]);
  const [exp] = await listAuthorExperiments('author-1');
  expect(exp.variants[0].sufficient).toBe(false);
  expect(exp.variants[0].engagement_rate).toBeNull();
});

test('la portee ignore le gonflement des impressions au defilement', () => {
  // Le cas reel qui a declenche la correction : 129 evenements `View` pour
  // 8 personnes servies. Le seuil doit se juger sur les 8, pas sur les 129 —
  // sinon une variante « franchit » le seuil parce qu'UN lecteur a fait
  // defiler son fil vingt fois.
  sequelize.query.mockResolvedValue([
    row({ impressions: 129, interactions: 7, reach: 8, min_impressions_per_variant: 20 }),
  ]);
  return listAuthorExperiments('author-1').then(([exp]) => {
    expect(exp.variants[0].sufficient).toBe(false);
    expect(exp.variants[0].engagement_rate).toBeNull();
    expect(exp.variants[0].reach).toBe(8);
  });
});

test('le taux se calcule par exposition', () => {
  // Depuis la correction du Rust, toute reception compte une exposition :
  // `impressions >= interactions` par construction, donc le rapport est un
  // vrai taux borne par 1.
  sequelize.query.mockResolvedValue([
    row({ impressions: 20, interactions: 5, reach: 10 }),
  ]);
  return listAuthorExperiments('author-1').then(([exp]) => {
    expect(exp.variants[0].engagement_rate).toBeCloseTo(0.25);
  });
});

test('le SEUIL reste sur les personnes, pas sur les expositions', () => {
  // Le cas reel : 129 expositions pour 8 personnes. La validite d'un test
  // tient au nombre de lecteurs INDEPENDANTS — un seul lecteur qui fait
  // defiler son fil vingt fois ne rend pas le resultat plus sur.
  sequelize.query.mockResolvedValue([
    row({ impressions: 129, interactions: 7, reach: 8, min_impressions_per_variant: 20 }),
  ]);
  return listAuthorExperiments('author-1').then(([exp]) => {
    expect(exp.variants[0].sufficient).toBe(false);
    expect(exp.variants[0].engagement_rate).toBeNull();
  });
});
