const express = require('express');
const { documents, DOCUMENT_VERSION } = require('../legal/documents');

const router = express.Router();

/**
 * Documents contractuels, en acces PUBLIC et sans authentification.
 *
 * C'est deliberé : une personne doit pouvoir lire ce qu'on lui demande
 * d'accepter AVANT d'avoir un compte, et un lien envoye a un tiers (autorite,
 * boutique d'applications) doit s'ouvrir sans connexion. Un consentement donne
 * sur un document illisible ne vaut rien.
 */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ESCAPE[char]);
}

/**
 * Gabarit autonome : aucune ressource externe, donc la page reste lisible hors
 * ligne dans une vue web embarquee, et s'adapte au theme clair ou sombre du
 * lecteur.
 */
function renderDocument(document) {
  const sections = document.sections
    .map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.body}</section>`)
    .join('\n');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.title)} — TwitNinf</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#16161a; --muted:#5b5b66; --line:#e3e3e9; --accent:#4c3ad6; --card:#f7f7fa; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0b0f; --fg:#f2f2f5; --muted:#a0a0ad; --line:#26262e; --accent:#9d8dff; --card:#141419; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 72px; background:var(--bg); color:var(--fg);
    font:16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 28px; line-height:1.25; letter-spacing:-0.02em; margin:0 0 6px; }
  .version { margin:0 0 34px; color:var(--muted); font-size:13px; }
  h2 { font-size:18px; letter-spacing:-0.01em; margin:34px 0 10px; padding-top:18px; border-top:1px solid var(--line); }
  section:first-of-type h2 { border-top:0; padding-top:0; }
  p, li { color:var(--fg); }
  ul { padding-left:20px; }
  li { margin-bottom:7px; }
  a { color:var(--accent); }
  strong { font-weight:650; }
  .table-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table { width:100%; border-collapse:collapse; margin:14px 0; font-size:14px; min-width:640px; }
  th, td { padding:10px 12px; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); }
  th { background:var(--card); font-weight:650; }
  footer { margin-top:44px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(document.title)}</h1>
<p class="version">TwitNinf · version ${escapeHtml(document.version)}</p>
${sections}
<footer>
  <a href="/legal/cgu">Conditions générales d'utilisation</a> ·
  <a href="/legal/confidentialite">Politique de confidentialité</a>
</footer>
</main>
<script>
  // Les tableaux larges defilent dans leur propre boite : sans ca, la page
  // entiere defile lateralement sur telephone.
  document.querySelectorAll('table').forEach(function (table) {
    var wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
</script>
</body>
</html>`;
}

function serve(document) {
  return (req, res) => {
    if (req.query.format === 'json') {
      return res.json({
        success: true,
        data: {
          slug: document.slug,
          title: document.title,
          version: document.version,
          sections: document.sections,
        },
      });
    }
    res.type('html').send(renderDocument(document));
  };
}

router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      version: DOCUMENT_VERSION,
      documents: [
        { slug: documents.terms.slug, title: documents.terms.title, path: '/legal/cgu' },
        { slug: documents.privacy.slug, title: documents.privacy.title, path: '/legal/confidentialite' },
      ],
    },
  });
});

router.get('/cgu', serve(documents.terms));
router.get('/confidentialite', serve(documents.privacy));

module.exports = router;
