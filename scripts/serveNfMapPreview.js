'use strict';

/**
 * Aperçu de la Carte NF hors téléphone.
 *
 * ── À quoi ça sert ──
 * Le fond de la Carte NF est une page servie par l'API et affichée dans une
 * `WebView` (voir `src/services/nfMapWebView.js`). Itérer dessus en passant par
 * un build de l'app coûte une quinzaine de minutes par essai. Ce script monte
 * les mêmes routes, sans les modèles Sequelize — donc sans base de données — et
 * ouvre la page dans un navigateur ordinaire.
 *
 * ── Ce qu'il ne prouve pas ──
 * Le comportement du pont avec l'app. `window.ReactNativeWebView` n'existe pas
 * dans un navigateur : les messages montants sont donc affichés dans la console
 * plutôt qu'envoyés. C'est suffisant pour le rendu, les gestes et les épingles ;
 * ça ne remplace pas un essai sur appareil pour la sensation du geste.
 *
 * ── Style ──
 * Le même que la production : le service a un défaut (CARTO dark-matter,
 * repeint à la palette de l'app), donc l'aperçu montre bien ce que verra le
 * téléphone. Pour essayer un autre fournisseur, exporter `NF_MAP_STYLE_URL`.
 *
 *   node scripts/serveNfMapPreview.js
 */

require('dotenv').config();

const path = require('path');
const express = require('express');

// Rien à forcer ici : sans `NF_MAP_STYLE_URL`, le service retombe sur le même
// fond que la production (CARTO dark-matter), repeint à la palette de l'app.
// Exporter la variable permet d'essayer un autre fournisseur sans toucher au
// code.

const PORT = Number(process.env.NF_MAP_PREVIEW_PORT) || 4601;
const BASE = `http://localhost:${PORT}/api/nf-map`;

// Le service lit l'origine publique pour fabriquer les URLs du style : ici
// elle doit désigner ce serveur, sinon la page ira chercher ses tuiles en prod.
process.env.PUBLIC_MEDIA_ORIGIN = `http://localhost:${PORT}`;

const nfMapWebView = require('../src/services/nfMapWebView');

const app = express();
const router = express.Router();

async function pipeUpstream(res, url, contentType) {
  const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).end();
  const body = Buffer.from(await upstream.arrayBuffer());
  res.set(
    'Content-Type',
    contentType || upstream.headers.get('content-type') || 'application/octet-stream'
  );
  return res.send(body);
}

router.get('/view', (req, res) => {
  const nonce = nfMapWebView.__nonce();
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "worker-src 'self'",
      "child-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      // Volontairement absent ici, contrairement à la vraie route : l'aperçu
      // doit pouvoir être encadré par la page de contrôle ci-dessous.
    ].join('; ')
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(nfMapWebView.pageHtml({ base: BASE, nonce, theme: req.query.theme }));
});

router.get('/bridge.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  return res.sendFile(path.join(__dirname, '../src/web/nf-map/bridge.js'));
});

router.get(/^\/(maplibre\.js|maplibre-worker\.js|maplibre\.css)$/, (req, res) => {
  const file = nfMapWebView.maplibreFile(req.params[0]);
  if (!file) return res.status(404).end();
  res.set(
    'Content-Type',
    file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
  );
  return res.sendFile(file);
});

router.get('/style.json', async (req, res) => {
  try {
    return res.json(await nfMapWebView.clientStyle(BASE, req.query.theme));
  } catch (error) {
    console.error('[aperçu] style:', error.message);
    return res.status(502).end();
  }
});

router.get('/tiles/:source/:z/:x/:y', async (req, res) => {
  try {
    const url = await nfMapWebView.tileUpstream(
      BASE,
      req.params.source,
      Number(req.params.z),
      Number(req.params.x),
      Number(String(req.params.y).replace(/\..*$/, ''))
    );
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url);
  } catch (error) {
    console.error('[aperçu] tuile:', error.message);
    return res.status(502).end();
  }
});

router.get('/glyphs/:fontstack/:range.pbf', async (req, res) => {
  try {
    const url = await nfMapWebView.glyphUpstream(BASE, req.params.fontstack, req.params.range);
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url, 'application/x-protobuf');
  } catch (error) {
    console.error('[aperçu] glyphes:', error.message);
    return res.status(502).end();
  }
});

router.get(/^\/sprite(@2x)?\.(json|png)$/, async (req, res) => {
  try {
    const variant = `${req.params[0] || ''}.${req.params[1]}`;
    const url = await nfMapWebView.spriteUpstream(BASE, variant);
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url, req.params[1] === 'png' ? 'image/png' : 'application/json');
  } catch (error) {
    console.error('[aperçu] sprite:', error.message);
    return res.status(502).end();
  }
});

app.use('/api/nf-map', router);

/**
 * Page de contrôle : elle joue le rôle de l'app.
 *
 * Elle fournit le `window.ReactNativeWebView` que la page attend, appelle
 * `init`, pousse des épingles et affiche les messages montants. C'est le seul
 * moyen de vérifier le contrat du pont sans appareil.
 */
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Aperçu Carte NF</title>
<style>
 html,body{margin:0;height:100%;background:#0A0A0A;font:13px system-ui;color:#ddd}
 #frame{position:absolute;inset:0 0 180px 0;width:100%;height:calc(100% - 180px);border:0}
 #log{position:absolute;bottom:0;left:0;right:0;height:180px;margin:0;overflow:auto;
   background:#050505;color:#7ec87e;font:11px ui-monospace,monospace;padding:8px;
   border-top:1px solid #222}
</style></head><body>
<iframe id="frame" src="/api/nf-map/view"></iframe>
<pre id="log"></pre>
<script>
const out = document.getElementById('log');
const log = (...a) => { out.textContent += a.join(' ') + '\\n'; out.scrollTop = 1e9; };
const frame = document.getElementById('frame');

frame.onload = () => {
  const w = frame.contentWindow;

  // Ce que l'app expose à la page.
  w.ReactNativeWebView = { postMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.type === 'region') {
      const b = msg.bounds;
      log('<< region  N' + b.north.toFixed(3) + ' S' + b.south.toFixed(3) +
          ' E' + b.east.toFixed(3) + ' O' + b.west.toFixed(3));
    } else {
      log('<< ' + msg.type + (msg.id ? '  ' + msg.id : ''));
    }
    if (msg.type === 'ready') {
      log('>> setMarkers(3)');
      w.NFMAP.setMarkers([
        { id:'a', latitude:48.8566, longitude:2.3522, anchorY:0.7297, zIndex:2,
          image:'https://placehold.co/192x148/FE2C55/ffffff.png?text=A' },
        { id:'b', latitude:48.8700, longitude:2.3300, anchorY:0.7297, zIndex:2,
          image:'https://placehold.co/192x148/2C55FE/ffffff.png?text=B' },
        { id:'c', latitude:48.8400, longitude:2.3700, anchorY:0.6667, zIndex:3,
          image:'https://placehold.co/216x120/22AA55/ffffff.png?text=C' }
      ]);
      setTimeout(() => { log('>> jumpTo(48.8566, 2.3522, 13)');
        w.NFMAP.jumpTo(48.8566, 2.3522, 13); }, 1800);
    }
  }};

  log('>> init(zoom 11, Paris)');
  w.NFMAP.init({ style:'/api/nf-map/style.json', latitude:48.8566, longitude:2.3522, zoom:11 });
};
</script></body></html>`);
});

app.listen(PORT, () => {
  console.log(`[aperçu] Carte NF : http://localhost:${PORT}/`);
  console.log(`[aperçu] page seule : ${BASE}/view`);
});
