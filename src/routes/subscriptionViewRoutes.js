'use strict';

/**
 * La page d'abonnement, servie comme une page.
 *
 * ── Pourquoi une page et pas un écran natif ──
 * L'offre bouge souvent : un palier gagne un avantage, un plafond change, un
 * libellé se reformule. Chacune de ces retouches, en natif, demande un build
 * mobile et une publication dans un magasin — donc des jours, pour une phrase.
 * Servie ici, la même retouche part avec l'API.
 *
 * ── Ce que cette page N'EST PAS ──
 * Elle ne contient aucune donnée et ne porte aucun jeton. C'est un moteur de
 * rendu vide : l'application lui pousse l'état (palier courant, avantages,
 * prix, solde) par `postMessage`, avec son propre jeton, et exécute
 * elle-même l'achat. Une WebView ne doit pas pouvoir débiter un compte — c'est
 * de l'argent réel, et les règles des magasins l'exigent aussi. Même modèle
 * que la Carte NF (`services/nfMapWebView.js`), pour la même raison.
 *
 * ── Pourquoi aucune authentification ici ──
 * Conséquence directe du point précédent : servir ce bundle à un inconnu ne
 * révèle rien, puisqu'il ne contient que de la mise en page. L'exiger
 * obligerait à passer un jeton dans l'URL de la WebView, donc à l'écrire dans
 * les journaux d'accès — précisément ce qu'on cherche à éviter.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const logger = require('../utils/logger');

const router = express.Router();

/** Racine du bundle bâti, déposé par `twitninf-subscription/scripts/copy-to-api.mjs`. */
const VIEW_DIR = path.join(__dirname, '..', 'subscriptionView');
const INDEX_FILE = path.join(VIEW_DIR, 'index.html');

/**
 * CSP de la page.
 *
 * `default-src 'none'` puis on ouvre au strict nécessaire. Les scripts et les
 * styles sont des fichiers servis par cette API (Vite les émet à part, jamais
 * en ligne), donc `'self'` suffit — ni nonce ni `unsafe-inline`.
 *
 * `connect-src 'none'` est le point important : la page n'a AUCUN appel réseau
 * à faire. Tout lui arrive par le pont. Verrouiller ici garantit qu'un bug —
 * ou un jour une dépendance — ne puisse pas se mettre à appeler quoi que ce
 * soit avec ce que la page affiche.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * GET /api/subscription/view
 *
 * Cache court : la page est minuscule et ne fait que désigner ses fichiers.
 * Tout ce qui pèse (le bundle, les polices) porte un nom haché par Vite, donc
 * une URL immuable, et se met en cache pour un an — voir plus bas.
 */
router.get('/view', (req, res) => {
  if (!fs.existsSync(INDEX_FILE)) {
    // Bundle absent : le build n'a pas été déposé avant le déploiement. On le
    // dit clairement plutôt que de renvoyer un 404 nu, qui enverrait chercher
    // une route manquante alors que c'est un artefact de build qui manque.
    logger.error('[subscription] Bundle absent — lancer `npm run deploy` dans twitninf-subscription/');
    return res.status(503).json({
      success: false,
      message: 'Page d\'abonnement indisponible (bundle non déployé).',
    });
  }

  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=300');
  return res.sendFile(INDEX_FILE);
});

/**
 * Les fichiers du bundle.
 *
 * `immutable` est tenable parce que Vite met une empreinte du CONTENU dans
 * chaque nom de fichier : un changement produit une autre URL. Sans ce hachage
 * la règle serait un piège — les appareils garderaient un an durant une
 * version périmée, sans le moindre signe.
 */
router.use(
  '/assets',
  express.static(path.join(VIEW_DIR, 'assets'), {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff');
    },
  })
);

module.exports = router;
