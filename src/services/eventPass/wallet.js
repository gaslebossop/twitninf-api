/**
 * Ajout d'une place au portefeuille du téléphone — Apple Wallet et Google Wallet.
 *
 * ── Pourquoi la génération vit côté serveur ────────────────────────────────
 * Les deux portefeuilles exigent une signature faite avec une clé privée : un
 * certificat Pass Type ID chez Apple, un compte de service chez Google. Cette
 * clé ne doit jamais quitter le serveur, et encore moins voyager dans l'app —
 * c'est pour ça que ce fichier vit dans `api/`, pas dans `twitninfbeta/`.
 *
 * ── Configuration, aucune par défaut ───────────────────────────────────────
 * Rien ne fonctionne tant que ces variables ne sont pas posées sur le VPS :
 *
 *   Apple  APPLE_TEAM_ID, APPLE_PASS_TYPE_ID,
 *          APPLE_WWDR_PEM, APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM
 *          (les trois derniers en base64 d'un fichier PEM),
 *          APPLE_PASS_KEY_PASSPHRASE (optionnelle, si la clé est chiffrée)
 *
 *   Google GOOGLE_WALLET_ISSUER_ID,
 *          GOOGLE_WALLET_SERVICE_ACCOUNT (base64 du JSON de la clé de service)
 *
 * Sans elles, `appleWalletConfigured()` / `googleWalletConfigured()` renvoient
 * `false` et les fonctions de construction lèvent `EventPassError` avec le
 * code `WALLET_NOT_CONFIGURED`. C'est volontaire : mieux vaut un bouton absent
 * (voir `GET /wallet-status`) qu'un pass mal signé qu'un téléphone refuse en
 * silence.
 *
 * ── Ce qui n'a jamais tourné contre de vrais certificats ───────────────────
 * Écrit et relu contre la documentation de `passkit-generator` (v3, modèle par
 * buffers) et la spec REST de Google Wallet, mais **jamais exercé avec un
 * certificat Pass Type ID ni un compte de service réels** — aucun des deux
 * n'existait au moment d'écrire ce fichier. À vérifier sur un vrai appareil dès
 * que les identifiants existent, comme le reste de la fonctionnalité places
 * d'invitation (voir `PLACES-TWITNINF-PASSATION.md`).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const config = require('../../config/config');
const eventPassService = require('../eventPassService');
const { logoMark, PULSE, TIERS: TIER_ART } = require('./passArt');

const { EventPassError } = eventPassService;

// ── Configuration ────────────────────────────────────────────────────────

function readEnvBuffer(name) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  try {
    const buffer = Buffer.from(raw.trim(), 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function appleCertificates() {
  const wwdr = readEnvBuffer('APPLE_WWDR_PEM');
  const signerCert = readEnvBuffer('APPLE_PASS_CERT_PEM');
  const signerKey = readEnvBuffer('APPLE_PASS_KEY_PEM');
  const teamIdentifier = (process.env.APPLE_TEAM_ID || '').trim();
  const passTypeIdentifier = (process.env.APPLE_PASS_TYPE_ID || '').trim();
  if (!wwdr || !signerCert || !signerKey || !teamIdentifier || !passTypeIdentifier) return null;
  return {
    wwdr,
    signerCert,
    signerKey,
    signerKeyPassphrase: process.env.APPLE_PASS_KEY_PASSPHRASE || undefined,
    teamIdentifier,
    passTypeIdentifier,
  };
}

function googleServiceAccount() {
  const raw = readEnvBuffer('GOOGLE_WALLET_SERVICE_ACCOUNT');
  const issuerId = (process.env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  if (!raw || !issuerId) return null;
  try {
    const json = JSON.parse(raw.toString('utf8'));
    if (!json.client_email || !json.private_key) return null;
    return { issuerId, clientEmail: json.client_email, privateKey: json.private_key };
  } catch {
    return null;
  }
}

function appleWalletConfigured() {
  return !!appleCertificates();
}

function googleWalletConfigured() {
  return !!googleServiceAccount();
}

// ── Marque, rastérisée pour les deux portefeuilles ─────────────────────────

/**
 * Le chat de la marque, en PNG, à la taille demandée. Réutilise `logoMark`
 * (déjà exporté par `passArt.js`, la même géométrie que sur la place
 * imprimée) plutôt que de dupliquer un tracé.
 */
async function brandMarkPng({ size, fill, background = null }) {
  const pad = Math.round(size * 0.18);
  const inner = size - pad * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + (background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '')
    + logoMark(pad, pad, inner, fill)
    + '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Image publique utilisée par Google Wallet : `sourceUri.uri` exige une URL
 * HTTPS, pas un data URI, donc un fichier ne suffit pas — il faut une route.
 * Fond plein (pas de transparence) : c'est la règle de surfaces pleines de la
 * DA « Pulse », et Google recadre parfois en cercle, où une transparence mal
 * bordée se voit.
 */
async function brandLogoPng(size = 660) {
  return brandMarkPng({ size, fill: PULSE.magenta, background: PULSE.bg });
}

// ── Apple Wallet ─────────────────────────────────────────────────────────

async function buildApplePkpass(passRow) {
  const certificates = appleCertificates();
  if (!certificates) {
    throw new EventPassError(
      'Apple Wallet n\'est pas encore activé pour TwitNinf.',
      'WALLET_NOT_CONFIGURED',
      503
    );
  }

  // Import différé : la dépendance ne doit peser que si elle sert vraiment.
  const { PKPass } = require('passkit-generator');

  const art = eventPassService.toArtModel(passRow);
  const qrPayload = eventPassService.buildQrPayload(passRow.code);
  const passUrl = eventPassService.buildPassUrl(passRow.code);
  const tier = TIER_ART[passRow.tier] || TIER_ART.standard;

  const [icon1x, icon2x, icon3x, logo1x, logo2x] = await Promise.all([
    brandMarkPng({ size: 29, fill: PULSE.magenta, background: PULSE.bg }),
    brandMarkPng({ size: 58, fill: PULSE.magenta, background: PULSE.bg }),
    brandMarkPng({ size: 87, fill: PULSE.magenta, background: PULSE.bg }),
    // Le logo se pose SUR le fond noir de la place : blanc, pas magenta, pour
    // rester lisible quel que soit le palier affiché à côté.
    brandMarkPng({ size: 50, fill: '#FFFFFF' }),
    brandMarkPng({ size: 100, fill: '#FFFFFF' }),
  ]);

  const pass = new PKPass(
    {
      'icon.png': icon1x,
      'icon@2x.png': icon2x,
      'icon@3x.png': icon3x,
      'logo.png': logo1x,
      'logo@2x.png': logo2x,
    },
    {
      wwdr: certificates.wwdr,
      signerCert: certificates.signerCert,
      signerKey: certificates.signerKey,
      signerKeyPassphrase: certificates.signerKeyPassphrase,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: certificates.passTypeIdentifier,
      teamIdentifier: certificates.teamIdentifier,
      organizationName: 'TwitNinf',
      description: `Place TwitNinf — ${passRow.event_name}`,
      serialNumber: passRow.code,
      backgroundColor: 'rgb(10,10,10)',
      foregroundColor: 'rgb(255,255,255)',
      labelColor: 'rgb(255,255,255)',
      logoText: 'twitninf',
    }
  );

  // `eventTicket` n'existe pas dans le schéma des props « overridables » du
  // constructeur (`OverridablePassProps`) — il est silencieusement ignoré s'il
  // y est passé. Le type se fixe UNIQUEMENT par ce setter, qui initialise au
  // passage les tableaux de champs (`primaryFields`, etc.) : sans lui, chaque
  // `.push` ci-dessous lève « Cannot read properties of undefined ».
  pass.type = 'eventTicket';

  pass.primaryFields.push({ key: 'event', label: 'ÉVÉNEMENT', value: passRow.event_name });

  const secondary = [{ key: 'guest', label: 'INVITÉ·E', value: passRow.guest_name || 'Invité·e' }];
  if (art.event_date) secondary.push({ key: 'date', label: 'DATE', value: art.event_date });
  pass.secondaryFields.push(...secondary);

  const auxiliary = [
    { key: 'serial', label: 'PLACE', value: `Nº ${String(passRow.serial).padStart(3, '0')}` },
    { key: 'tier', label: 'PALIER', value: tier.label.toUpperCase() },
  ];
  if (passRow.event_place) auxiliary.push({ key: 'place', label: 'LIEU', value: passRow.event_place });
  pass.auxiliaryFields.push(...auxiliary);

  pass.backFields.push(
    { key: 'code', label: 'Code', value: passRow.code },
    { key: 'lien', label: 'Lien', value: passUrl },
    {
      key: 'info',
      label: 'À savoir',
      value: 'Une place, une entrée. Le code est unique et vérifié à la porte.',
    }
  );

  // Même URL que le code QR dessiné dans l'app : un seul générateur de
  // contenu, jamais un deuxième encodage à faire concorder avec le premier.
  pass.setBarcodes(qrPayload);

  return pass.getAsBuffer();
}

// ── Google Wallet ────────────────────────────────────────────────────────

/**
 * Lien « Ajouter à Google Wallet ». Contrairement à Apple, pas de fichier à
 * signer : un JWT signé RS256 porte la classe ET l'objet en clair dans sa
 * charge utile (`genericClasses` / `genericObjects`), donc aucun appel à
 * l'API REST de Google n'est nécessaire pour émettre ce lien — seul le compte
 * de service doit exister côté Google Cloud.
 */
function buildGoogleSaveUrl(passRow) {
  const account = googleServiceAccount();
  if (!account) {
    throw new EventPassError(
      'Google Wallet n\'est pas encore activé pour TwitNinf.',
      'WALLET_NOT_CONFIGURED',
      503
    );
  }

  const art = eventPassService.toArtModel(passRow);
  const qrPayload = eventPassService.buildQrPayload(passRow.code);
  const origin = eventPassService.passOrigin();
  const tier = TIER_ART[passRow.tier] || TIER_ART.standard;

  const classId = `${account.issuerId}.twitninf_event_pass`;
  const objectId = `${account.issuerId}.${eventPassService.normalizeCode(passRow.code)}`;

  const textModules = [
    { id: 'guest', header: 'INVITÉ·E', body: passRow.guest_name || 'Invité·e' },
    { id: 'serial', header: 'PLACE', body: `Nº ${String(passRow.serial).padStart(3, '0')}` },
    { id: 'tier', header: 'PALIER', body: tier.label.toUpperCase() },
  ];
  if (art.event_date) textModules.push({ id: 'date', header: 'DATE', body: art.event_date });
  if (passRow.event_place) textModules.push({ id: 'place', header: 'LIEU', body: passRow.event_place });

  const genericObject = {
    id: objectId,
    classId,
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    cardTitle: { defaultValue: { language: 'fr', value: 'twitninf' } },
    subheader: { defaultValue: { language: 'fr', value: 'Place d’invitation' } },
    header: { defaultValue: { language: 'fr', value: passRow.event_name } },
    textModulesData: textModules,
    barcode: { type: 'QR_CODE', value: qrPayload, alternateText: passRow.code },
    hexBackgroundColor: '#0A0A0A',
    logo: { sourceUri: { uri: `${origin}/api/event-passes/wallet/logo.png` } },
    state: 'ACTIVE',
  };

  const claims = {
    iss: account.clientEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [origin],
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [genericObject],
    },
  };

  const token = jwt.sign(claims, account.privateKey, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// ── Jeton court pour le lien Apple Wallet ───────────────────────────────────
//
// `Linking.openURL` (et Safari, quand il gère un .pkpass) n'envoie jamais
// l'en-tête `Authorization` de l'app. Le seul appel authentifié est celui qui
// DEMANDE ce lien (`GET /:id/wallet/apple-link`, JWT normal) ; le lien renvoyé
// porte sa propre signature courte, valable 10 minutes, comme les jetons de
// porte (`eventPassService.createDoorToken`) — même idée, contexte différent,
// d'où une clé dérivée différemment (`...:wallet:v1`).

let cachedWalletKey = null;

function walletSigningKey() {
  if (cachedWalletKey) return cachedWalletKey;
  const secret = process.env.EVENT_PASS_SECRET || config.jwt?.secret;
  if (!secret) {
    throw new EventPassError('Aucune clé de signature disponible.', 'NO_SIGNING_KEY', 500);
  }
  cachedWalletKey = crypto.createHmac('sha256', secret).update('twitninf:event-pass:wallet:v1').digest();
  return cachedWalletKey;
}

function createWalletToken(passId, kind) {
  const payload = { id: passId, k: kind, e: Date.now() + 10 * 60 * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', walletSigningKey())
    .update(`w1:${body}`)
    .digest('base64url')
    .slice(0, 24);
  return `w1.${body}.${mac}`;
}

function verifyWalletToken(token, expectedKind) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'w1') return null;

  const expected = crypto.createHmac('sha256', walletSigningKey())
    .update(`w1:${parts[1]}`)
    .digest('base64url')
    .slice(0, 24);
  const given = Buffer.from(parts[2], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload?.id || payload.k !== expectedKind || !payload.e || payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  appleWalletConfigured,
  googleWalletConfigured,
  buildApplePkpass,
  buildGoogleSaveUrl,
  brandLogoPng,
  createWalletToken,
  verifyWalletToken,
};
