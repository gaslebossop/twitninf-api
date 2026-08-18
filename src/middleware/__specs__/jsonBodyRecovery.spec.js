const express = require('express');
const request = require('supertest');

const { unwrapStringBody, recoverUnparsableBody } = require('../jsonBodyRecovery');

/**
 * Regression : une version du client envoyait un corps JSON doublement
 * encode. Le serveur repondait 500 et le suivi d'interaction etait perdu —
 * 128 rejets sur `/api/neural-rank/track` pour la seule journee du
 * 2026-08-18. Le client est corrige, mais les applications deja installees
 * continuent d'envoyer l'ancien format.
 */
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(unwrapStringBody);
  app.use(recoverUnparsableBody);
  app.post('/t', (req, res) => res.json({ got: req.body }));
  return app;
}

const post = (payload) =>
  request(buildApp()).post('/t').set('Content-Type', 'application/json').send(payload);

it('laisse un corps normal intact', async () => {
  const res = await post(JSON.stringify({ tweetId: 'a', interactionType: 'view' }));

  expect(res.status).toBe(200);
  expect(res.body.got).toEqual({ tweetId: 'a', interactionType: 'view' });
});

it('rattrape un corps doublement encode', async () => {
  const doubled = JSON.stringify(JSON.stringify({ tweetId: 'b', interactionType: 'like' }));

  const res = await post(doubled);

  expect(res.status).toBe(200);
  expect(res.body.got).toEqual({ tweetId: 'b', interactionType: 'like' });
});

it('rattrape un corps triplement encode', async () => {
  const tripled = JSON.stringify(JSON.stringify(JSON.stringify({ tweetId: 'c' })));

  const res = await post(tripled);

  expect(res.status).toBe(200);
  expect(res.body.got).toEqual({ tweetId: 'c' });
});

it('repond 400 et non 500 sur un corps vraiment illisible', async () => {
  // Une faute du client ne doit pas etre comptee comme une panne serveur :
  // c'est ce qui faussait la lecture des journaux.
  const res = await post('{casse,,,');

  expect(res.status).toBe(400);
});

it('refuse une chaine nue, comme le faisait deja express.json', async () => {
  // `express.json` tourne en mode `strict` : une chaine au premier niveau
  // etait DEJA refusee avant ce rattrapage. On le documente pour eviter qu'on
  // croie l'avoir casse — et le rattrapage ne doit pas se mettre a accepter
  // ce que le serveur refusait, ce serait un changement de contrat.
  const res = await post(JSON.stringify('bonjour'));

  expect(res.status).toBe(400);
});

it('ne boucle pas indefiniment sur un empilement absurde', async () => {
  // Borne de securite : une entree construite exprès ne doit pas faire
  // tourner le parseur sans fin.
  let payload = JSON.stringify({ tweetId: 'z' });
  for (let i = 0; i < 12; i += 1) payload = JSON.stringify(payload);

  const res = await post(payload);

  expect(res.status).toBe(400);
});
