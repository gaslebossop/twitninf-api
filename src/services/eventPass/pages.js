/**
 * Les deux pages web des places : celle de l'invité, celle de la porte.
 *
 * ── Pourquoi du HTML servi par l'API ──────────────────────────────────────
 * Le code QR d'une place contient une URL. Toute personne qui la scanne avec
 * l'appareil photo de son téléphone — sans l'application — doit tomber sur
 * quelque chose de propre et de vérifiable. C'est la page de l'invité.
 * La page de la porte, elle, existe pour l'équipe qui n'a PAS l'application :
 * un lien à durée limitée, une caméra, un verdict lisible à bout de bras.
 *
 * ── Contrainte de sécurité du contenu ─────────────────────────────────────
 * `helmet` impose `script-src 'self'` : aucun script en ligne ne s'exécute.
 * Le script du scanner est donc servi par sa propre route, et la page de
 * l'invité n'a aucun script du tout. Les styles, eux, sont autorisés en ligne
 * (`style-src 'unsafe-inline'`).
 */

const { escapeXml, PULSE } = require('./passArt');

const BASE_CSS = `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:${PULSE.bg};color:#fff;
    font-family:'Plus Jakarta Sans','Segoe UI',Roboto,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:${PULSE.magenta}}
`;

const STATUS_TONE = {
  valid: { label: 'Place valide', color: '#22C55E' },
  used: { label: 'Place déjà utilisée', color: PULSE.gold },
  revoked: { label: 'Place annulée', color: '#F5372B' },
  expired: { label: 'Place expirée', color: '#F5372B' },
};

/**
 * Page de l'invité : la place, en grand, et une seule phrase d'état.
 * Pas de bouton, pas de compte à créer, pas d'application à installer — c'est
 * un billet, il se montre.
 */
function passPageHtml({ svg, pass, statusKey }) {
  const tone = STATUS_TONE[statusKey] || STATUS_TONE.valid;
  const title = `${pass.event_name} — place nº ${String(pass.serial).padStart(3, '0')}`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="${PULSE.bg}">
<title>${escapeXml(title)}</title>
<style>
${BASE_CSS}
  body{min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:20px 16px 40px;gap:18px}
  .etat{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;
    letter-spacing:.4px;padding:10px 18px;border-radius:999px;
    background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10)}
  .pastille{width:10px;height:10px;border-radius:50%;background:${tone.color}}
  .place{width:min(100%,420px)}
  .place svg{width:100%;height:auto;display:block}
  .pied{max-width:420px;text-align:center;font-size:13px;line-height:1.5;
    color:rgba(255,255,255,.45)}
</style>
</head>
<body>
  <div class="etat"><span class="pastille"></span>${escapeXml(tone.label)}</div>
  <div class="place">${svg}</div>
  <p class="pied">Garde cette page ou la capture d’écran : le code suffit à l’entrée.
  Une place n’ouvre qu’une fois.</p>
</body>
</html>`;
}

/** Page « introuvable » — même habillage, pour ne pas donner l'impression d'une panne. */
function passNotFoundHtml(message) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Place introuvable</title>
<style>
${BASE_CSS}
  body{min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;padding:24px;text-align:center}
  h1{font-size:26px;margin:0}
  p{margin:0;color:rgba(255,255,255,.55);max-width:340px;line-height:1.55}
</style>
</head>
<body>
  <h1>Cette place n’existe pas</h1>
  <p>${escapeXml(message || 'Le lien est incomplet, ou la place a été annulée.')}</p>
</body>
</html>`;
}

/**
 * Page de la porte. Tout est dimensionné pour être lu d'un coup d'œil, à bout
 * de bras, dans le noir : un bandeau de verdict qui occupe le tiers de l'écran,
 * une couleur, un nom.
 */
function scannerPageHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="${PULSE.bg}">
<title>Contrôle des entrées</title>
<style>
${BASE_CSS}
  body{min-height:100dvh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
  .titre{font-size:15px;font-weight:800;letter-spacing:.3px}
  .compteur{font-size:13px;color:rgba(255,255,255,.5);font-variant-numeric:tabular-nums}
  .cadre{position:relative;flex:1;min-height:34vh;background:#000;overflow:hidden}
  video{width:100%;height:100%;object-fit:cover;display:block}
  .mire{position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%);
    width:min(62vw,260px);aspect-ratio:1;border:3px solid rgba(255,255,255,.85);
    border-radius:24px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
  .verdict{padding:22px 18px;min-height:32vh;display:flex;flex-direction:column;
    justify-content:center;gap:8px;background:#141416;transition:background .12s linear}
  .verdict.ok{background:#0E3D22}
  .verdict.refus{background:#3D0F14}
  .verdict h2{margin:0;font-size:30px;line-height:1.1;font-weight:800}
  .verdict .qui{font-size:20px;font-weight:700;color:rgba(255,255,255,.92)}
  .verdict .detail{font-size:15px;color:rgba(255,255,255,.62)}
  .saisie{display:flex;gap:8px;padding:14px 18px 22px;
    border-top:1px solid rgba(255,255,255,.08)}
  input{flex:1;min-width:0;background:#1C1C20;border:1px solid rgba(255,255,255,.12);
    color:#fff;border-radius:12px;padding:14px;font-size:16px;
    font-family:ui-monospace,Consolas,monospace;text-transform:uppercase}
  button{background:${PULSE.magenta};color:#fff;border:0;border-radius:12px;
    padding:0 20px;font-size:16px;font-weight:800;cursor:pointer}
  button:disabled{opacity:.45}
  .avert{padding:12px 18px;background:#3D2A0F;font-size:14px;line-height:1.5;
    color:#FFD24D;display:none}
</style>
</head>
<body>
  <header>
    <span class="titre" id="evenement">Contrôle des entrées</span>
    <span class="compteur" id="compteur">0 entrée</span>
  </header>

  <div class="avert" id="avert"></div>

  <div class="cadre">
    <video id="video" playsinline muted></video>
    <div class="mire"></div>
  </div>

  <div class="verdict" id="verdict">
    <h2 id="verdictTitre">Prêt</h2>
    <div class="qui" id="verdictQui"></div>
    <div class="detail" id="verdictDetail">Présente une place devant l’appareil photo.</div>
  </div>

  <form class="saisie" id="saisie">
    <input id="code" name="code" placeholder="NINF-XXXX-XXXX" autocomplete="off"
      autocapitalize="characters" spellcheck="false">
    <button type="submit">Valider</button>
  </form>

  <script src="scanner.js"></script>
</body>
</html>`;
}

/**
 * Script du scanner.
 *
 * Deux détails qui comptent à une porte :
 *   • le MÊME code lu deux fois de suite en une seconde ne déclenche qu'un
 *     appel — sinon la caméra, qui lit dix fois par seconde, ferait passer la
 *     place puis annoncerait aussitôt « déjà utilisée » à cause de sa propre
 *     lecture ;
 *   • si `BarcodeDetector` n'existe pas (iOS Safari ne l'expose pas), la page
 *     ne prétend pas scanner : elle bascule sur la saisie du code imprimé et
 *     le dit.
 */
function scannerScript() {
  return `(function () {
  'use strict';

  var jeton = (location.hash.match(/t=([^&]+)/) || [])[1] || '';
  var video = document.getElementById('video');
  var verdict = document.getElementById('verdict');
  var titre = document.getElementById('verdictTitre');
  var qui = document.getElementById('verdictQui');
  var detail = document.getElementById('verdictDetail');
  var compteur = document.getElementById('compteur');
  var avert = document.getElementById('avert');
  var saisie = document.getElementById('saisie');
  var champ = document.getElementById('code');

  var entrees = 0;
  var dernier = { valeur: '', instant: 0 };
  var occupe = false;

  function prevenir(texte) {
    avert.textContent = texte;
    avert.style.display = 'block';
  }

  function afficher(etat, titreTexte, quiTexte, detailTexte) {
    verdict.className = 'verdict' + (etat ? ' ' + etat : '');
    titre.textContent = titreTexte;
    qui.textContent = quiTexte || '';
    detail.textContent = detailTexte || '';
  }

  function vibrer(motif) {
    if (navigator.vibrate) navigator.vibrate(motif);
  }

  function nomInvite(place) {
    if (!place) return '';
    var numero = 'Nº ' + String(place.serial).padStart(3, '0');
    return (place.guest_name ? place.guest_name + ' · ' : '') + numero;
  }

  function palier(place) {
    if (!place || !place.tier || place.tier === 'standard') return '';
    return ' · ' + place.tier.toUpperCase();
  }

  function valider(valeur) {
    if (occupe) return;
    var maintenant = Date.now();
    if (valeur === dernier.valeur && maintenant - dernier.instant < 2500) return;
    dernier = { valeur: valeur, instant: maintenant };
    occupe = true;

    fetch('/api/event-passes/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Door-Token': jeton },
      body: JSON.stringify({ token: valeur })
    })
      .then(function (r) { return r.json().then(function (b) { return { statut: r.status, corps: b }; }); })
      .then(function (reponse) {
        var corps = reponse.corps || {};
        if (reponse.statut === 401) {
          afficher('refus', 'Lien expiré', '', 'Demande un nouveau lien de contrôle.');
          vibrer([80, 60, 80]);
          return;
        }
        var data = corps.data || {};
        if (data.admitted) {
          entrees += 1;
          compteur.textContent = entrees + (entrees > 1 ? ' entrées' : ' entrée');
          afficher('ok', 'Entrée validée', nomInvite(data.pass),
            (data.pass ? data.pass.event_name : '') + palier(data.pass));
          vibrer(60);
        } else {
          afficher('refus', data.message || corps.message || 'Refusé',
            nomInvite(data.pass),
            data.reason === 'ALREADY_USED' && data.pass && data.pass.first_scanned_at
              ? 'Déjà passée à ' + new Date(data.pass.first_scanned_at).toLocaleTimeString('fr-FR')
              : '');
          vibrer([80, 60, 80]);
        }
      })
      .catch(function () {
        afficher('refus', 'Réseau indisponible', '', 'Réessaie dans un instant.');
      })
      .then(function () { occupe = false; });
  }

  saisie.addEventListener('submit', function (evenement) {
    evenement.preventDefault();
    var valeur = champ.value.trim();
    if (!valeur) return;
    champ.value = '';
    // Une saisie manuelle doit pouvoir être retentée tout de suite.
    dernier = { valeur: '', instant: 0 };
    valider(valeur);
  });

  if (!jeton) {
    prevenir('Lien de contrôle absent. Ouvre le lien fourni par l’organisation.');
  }

  if (!('BarcodeDetector' in window)) {
    prevenir('Cet appareil ne sait pas lire les codes depuis le navigateur '
      + '(c’est le cas sur iPhone). Tape le code imprimé sur la place, ou '
      + 'utilise l’application TwitNinf.');
    video.parentElement.style.display = 'none';
    champ.focus();
    return;
  }

  var lecteur = new window.BarcodeDetector({ formats: ['qr_code'] });

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (flux) {
      video.srcObject = flux;
      return video.play();
    })
    .then(function () {
      setInterval(function () {
        if (video.readyState < 2) return;
        lecteur.detect(video)
          .then(function (codes) {
            if (codes && codes.length) valider(codes[0].rawValue);
          })
          .catch(function () { /* image illisible : on retentera dans 200 ms */ });
      }, 200);
    })
    .catch(function () {
      prevenir('Caméra indisponible. Tape le code imprimé sur la place.');
      champ.focus();
    });
}());`;
}

module.exports = {
  passPageHtml,
  passNotFoundHtml,
  scannerPageHtml,
  scannerScript,
};
