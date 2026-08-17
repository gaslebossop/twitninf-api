/**
 * Places d'invitation : émission, signature, contrôle à l'entrée.
 *
 * ── Ce que garantit la signature ──────────────────────────────────────────
 * Le code QR ne porte pas un identifiant de base, mais un code + une signature
 * HMAC-SHA256 tronquée. Trois propriétés en découlent :
 *   • personne ne peut FABRIQUER une place sans la clé ;
 *   • le contrôle à l'entrée peut écarter un faux sans même toucher la base ;
 *   • le code reste court, donc le motif reste gros et se scanne d'un geste.
 * Ce que la signature ne fait PAS : empêcher de photographier la place de
 * quelqu'un d'autre. C'est la consommation à usage unique, côté base, qui s'en
 * charge — d'où le verrou de ligne dans `redeem`.
 *
 * ── D'où vient la clé ─────────────────────────────────────────────────────
 * `EVENT_PASS_SECRET` si elle est définie, sinon une clé DÉRIVÉE de
 * `JWT_SECRET`. La dérivation évite d'avoir à poser une variable
 * d'environnement sur chaque nœud avant de pouvoir émettre la première place —
 * et comme `JWT_SECRET` est déjà commun aux deux VPS, une place émise sur l'un
 * se vérifie sur l'autre. La clé dérivée n'est jamais égale à `JWT_SECRET` :
 * une signature de place ne peut pas servir ailleurs.
 *
 * ⚠️ Faire tourner `JWT_SECRET` invalide toutes les places déjà distribuées.
 * Avant une rotation pendant qu'un événement est en cours, poser
 * `EVENT_PASS_SECRET` à la valeur dérivée de l'ancienne clé.
 */

const crypto = require('crypto');
const { Op } = require('sequelize');

const config = require('../config/config');
const { encodeQr } = require('./eventPass/qr');
const { EventPass, EventPassScan, User, sequelize } = require('../models');
const { getPublicMediaOrigin } = require('../utils/publicMediaOrigin');
const logger = require('../utils/logger');

// Alphabet sans caractères ambigus : ni 0/O, ni 1/I/L, ni U. Une place se lit
// au téléphone, à voix haute, dans le bruit — « zéro ou O ? » n'est pas une
// question qu'on veut entendre à une entrée.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PREFIX = 'NINF';
const CODE_BLOCK = 4;
const SIGNATURE_LENGTH = 10;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const MAX_BATCH = 500;

class EventPassError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'EventPassError';
    this.code = code;
    this.status = status;
  }
}

// ── Clé et signature ────────────────────────────────────────────────────────

let cachedKey = null;

function signingKey() {
  if (cachedKey) return cachedKey;

  const explicit = process.env.EVENT_PASS_SECRET;
  if (explicit && explicit.trim()) {
    cachedKey = Buffer.from(explicit.trim(), 'utf8');
    return cachedKey;
  }

  const jwtSecret = config.jwt?.secret;
  if (!jwtSecret) {
    throw new EventPassError(
      'Aucune clé de signature : définir EVENT_PASS_SECRET ou JWT_SECRET.',
      'NO_SIGNING_KEY',
      500
    );
  }
  cachedKey = crypto.createHmac('sha256', jwtSecret)
    .update('twitninf:event-pass:v1')
    .digest();
  return cachedKey;
}

/** Signature d'un code : 50 bits en base32, suffisants pour une porte. */
function signCode(code) {
  const digest = crypto.createHmac('sha256', signingKey())
    .update(normalizeCode(code))
    .digest();

  let out = '';
  for (let i = 0; i < SIGNATURE_LENGTH; i += 1) {
    // Cinq bits par caractère, lus en continu dans l'empreinte.
    const bitOffset = i * 5;
    const byteIndex = bitOffset >> 3;
    const window = (digest[byteIndex] << 8) | digest[byteIndex + 1];
    const value = (window >> (11 - (bitOffset % 8))) & 0b11111;
    out += BASE32[value];
  }
  return out;
}

/** Comparaison à temps constant : une comparaison naïve fuit la signature. */
function signatureMatches(code, candidate) {
  const expected = Buffer.from(signCode(code), 'utf8');
  const given = Buffer.from(String(candidate || '').toUpperCase(), 'utf8');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

// ── Codes ───────────────────────────────────────────────────────────────────

function randomBlock(length) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    // Rejet des valeurs qui déborderaient de l'alphabet : sans lui, les
    // premiers caractères de l'alphabet sortiraient un peu plus souvent.
    const value = bytes[i % bytes.length];
    if (value >= 256 - (256 % CODE_ALPHABET.length)) continue;
    out += CODE_ALPHABET[value % CODE_ALPHABET.length];
  }
  return out;
}

function generateCode() {
  return `${CODE_PREFIX}-${randomBlock(CODE_BLOCK)}-${randomBlock(CODE_BLOCK)}`;
}

/** Forme canonique : majuscules, sans tiret ni espace. */
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Remet les tirets pour l'affichage : NINF-XXXX-XXXX. */
function formatCode(compact) {
  const value = normalizeCode(compact);
  if (!value.startsWith(CODE_PREFIX)) return value;
  const body = value.slice(CODE_PREFIX.length);
  return [CODE_PREFIX, body.slice(0, CODE_BLOCK), body.slice(CODE_BLOCK)]
    .filter(Boolean)
    .join('-');
}

// ── Jeton présenté à l'entrée ───────────────────────────────────────────────

/**
 * Ce qu'on accepte au contrôle, du plus courant au plus manuel :
 *   • l'URL entière lue par l'appareil photo (majuscules ou non) ;
 *   • le jeton seul (code + signature), collé à la main ;
 *   • le code imprimé seul, tapé par l'équipe quand l'écran est cassé.
 *
 * Le dernier cas est volontaire : un code de huit caractères tiré dans un
 * alphabet de trente ne se devine pas à une porte, et refuser une place
 * authentique parce que l'écran ne s'allume plus n'aide personne. Le passage
 * est journalisé comme saisie manuelle.
 */
function parseToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let candidate = raw;
  const urlMatch = raw.match(/\/i\/([A-Za-z0-9]+)\/?$/i);
  if (urlMatch) candidate = urlMatch[1];
  else if (/^https?:\/\//i.test(raw)) {
    const tail = raw.replace(/[/?#].*$/, '').split('/').pop();
    candidate = tail || raw;
  }

  const compact = normalizeCode(candidate);
  if (!compact.startsWith(CODE_PREFIX)) return null;

  const codeLength = CODE_PREFIX.length + CODE_BLOCK * 2;
  if (compact.length === codeLength) {
    return { code: compact, signature: null, manual: true };
  }
  if (compact.length === codeLength + SIGNATURE_LENGTH) {
    return {
      code: compact.slice(0, codeLength),
      signature: compact.slice(codeLength),
      manual: false,
    };
  }
  return null;
}

function buildToken(code) {
  return `${normalizeCode(code)}${signCode(code)}`;
}

/**
 * URL inscrite dans le code QR — en MAJUSCULES, et ce n'est pas un détail :
 * le mode alphanumérique d'un code QR ne connaît pas les minuscules. En
 * majuscules la même adresse tient dans une version bien plus basse, donc des
 * modules plus gros, donc un scan qui prend une demi-seconde au lieu de trois.
 * Un nom d'hôte est insensible à la casse, et Express l'est aussi sur les
 * chemins par défaut.
 */
function buildQrPayload(code) {
  return `${passOrigin()}/I/${buildToken(code)}`.toUpperCase();
}

/** Même adresse, pour un lien cliquable (message, courriel, partage). */
function buildPassUrl(code) {
  return `${passOrigin()}/i/${buildToken(code)}`;
}

/**
 * La MATRICE du code QR, pour que l'app puisse dessiner la place elle-même.
 *
 * Pourquoi l'envoyer plutôt que de laisser le client encoder : l'encodeur vit
 * ici, et c'est lui que les specs relisent avec un vrai décodeur. Une seconde
 * implémentation côté mobile serait la même erreur de polynôme Reed-Solomon à
 * repayer, en silence et sans test. Pourquoi l'envoyer plutôt que le SVG déjà
 * rendu : la place doit s'afficher à l'entrée d'une salle où le réseau ne passe
 * pas, donc depuis un cache local — et une matrice tient en quelques centaines
 * d'octets là où le dessin en fait des dizaines de milliers.
 *
 * Niveau H comme le dessin imprimé : c'est ce que les specs valident, fenêtre
 * du logo comprise.
 */
function buildQrMatrix(code) {
  const qr = encodeQr(buildQrPayload(code), { level: 'H' });
  const rows = [];
  for (let row = 0; row < qr.size; row += 1) {
    let line = '';
    for (let col = 0; col < qr.size; col += 1) line += qr.isDark(row, col) ? '1' : '0';
    rows.push(line);
  }
  return { size: qr.size, level: 'H', rows };
}

function passOrigin() {
  return (process.env.EVENT_PASS_ORIGIN || getPublicMediaOrigin()).replace(/\/$/, '');
}

// ── Laissez-passer de contrôle ──────────────────────────────────────────────

/**
 * Jeton de poste de contrôle. Il autorise UNE action (valider une entrée) sur
 * UN événement, pendant quelques heures.
 *
 * Pourquoi pas simplement un compte modérateur : l'équipe qui tient la porte
 * n'est pas l'équipe de modération du réseau. Donner un rôle permanent à
 * quelqu'un pour une soirée, c'est un rôle qu'on oublie de retirer. Ici,
 * l'organisateur envoie un lien, le lien cesse de fonctionner tout seul, et il
 * ne donne accès à rien d'autre qu'à cette porte-là.
 */
function createDoorToken(eventSlug, hours = 12, issuerId = null) {
  const slug = normalizeSlug(eventSlug);
  if (!slug) throw new EventPassError('Événement inconnu.', 'EVENT_SLUG_REQUIRED');

  const span = Math.min(Math.max(Number(hours) || 12, 1), 72);
  const payload = {
    s: slug,
    e: Date.now() + span * 3600 * 1000,
    i: issuerId || null,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey())
    .update(`door:${body}`)
    .digest('base64url')
    .slice(0, 24);

  return { token: `d1.${body}.${mac}`, expires_at: new Date(payload.e), event_slug: slug };
}

function verifyDoorToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'd1') return null;

  const expected = crypto.createHmac('sha256', signingKey())
    .update(`door:${parts[1]}`)
    .digest('base64url')
    .slice(0, 24);
  const given = Buffer.from(parts[2], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload?.s || !payload?.e || payload.e < Date.now()) return null;
    return { event_slug: payload.s, expires_at: new Date(payload.e), issued_by: payload.i || null };
  } catch (error) {
    return null;
  }
}

// ── Émission ────────────────────────────────────────────────────────────────

function sanitizeText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeSlug(value) {
  const slug = String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || null;
}

/**
 * Émet un lot de places.
 *
 * Les invités peuvent être donnés nommément (`guests`) ou en nombre
 * (`quantity`) pour des places au porteur. Tout le lot est écrit dans UNE
 * transaction : un lot à moitié émis laisserait des numéros de place en trou,
 * et personne ne saurait dire si la place nº 7 existe.
 *
 * @param {object} input
 * @param {string} input.event_slug
 * @param {string} input.event_name
 * @param {string} [input.event_date] ISO
 * @param {string} [input.event_place]
 * @param {Array<{name?: string, user_id?: string, tier?: string}>} [input.guests]
 * @param {number} [input.quantity]
 * @param {string} [input.tier]
 * @param {number} [input.max_scans]
 * @param {string} [input.expires_at] ISO
 * @param {string} [input.note]
 * @param {string} issuerId compte émetteur
 */
async function createBatch(input, issuerId) {
  const slug = normalizeSlug(input.event_slug);
  if (!slug) {
    throw new EventPassError('Donne un identifiant d\'événement.', 'EVENT_SLUG_REQUIRED');
  }

  const eventName = sanitizeText(input.event_name, 120);
  if (!eventName) {
    throw new EventPassError('Donne un nom d\'événement.', 'EVENT_NAME_REQUIRED');
  }

  const guests = Array.isArray(input.guests) ? input.guests : [];
  const quantity = Number.parseInt(input.quantity, 10) || 0;
  const total = guests.length || quantity;

  if (total < 1) {
    throw new EventPassError('Indique au moins une place à émettre.', 'EMPTY_BATCH');
  }
  if (total > MAX_BATCH) {
    throw new EventPassError(
      `Un lot va jusqu'à ${MAX_BATCH} places. Émets-en plusieurs.`,
      'BATCH_TOO_LARGE'
    );
  }

  const defaultTier = normalizeTier(input.tier);
  const maxScans = clampScans(input.max_scans);
  const expiresAt = parseDate(input.expires_at);
  const eventDate = parseDate(input.event_date);
  const eventPlace = sanitizeText(input.event_place, 120);
  const note = sanitizeText(input.note, 160);

  const rows = [];
  for (let i = 0; i < total; i += 1) {
    const guest = guests[i] || {};
    rows.push({
      event_slug: slug,
      event_name: eventName,
      event_date: eventDate,
      event_place: eventPlace,
      tier: normalizeTier(guest.tier || defaultTier),
      guest_name: sanitizeText(guest.name, 80),
      guest_user_id: guest.user_id || null,
      max_scans: maxScans,
      expires_at: expiresAt,
      note,
      created_by: issuerId || null,
    });
  }

  return sequelize.transaction(async (transaction) => {
    // Verrou consultatif porté par le slug : deux émissions simultanées sur le
    // MÊME événement se suivent, deux émissions sur des événements différents
    // ne s'attendent pas. Sans lui, les deux lots calculeraient le même
    // premier numéro et l'un des deux échouerait sur l'index unique.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:slug))', {
      replacements: { slug },
      transaction,
    });

    const [{ last }] = await sequelize.query(
      'SELECT COALESCE(MAX(serial), 0) AS last FROM event_passes WHERE event_slug = :slug',
      { replacements: { slug }, type: sequelize.QueryTypes.SELECT, transaction }
    );

    let serial = Number(last) || 0;
    const prepared = rows.map((row) => {
      serial += 1;
      return { ...row, serial, code: generateCode() };
    });

    const created = await EventPass.bulkCreate(prepared, { transaction, validate: true });
    return created;
  });
}

function normalizeTier(tier) {
  const value = String(tier || 'standard').toLowerCase();
  return EventPass.TIERS.includes(value) ? value : 'standard';
}

function clampScans(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 50);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Contrôle à l'entrée ─────────────────────────────────────────────────────

const REFUSAL_MESSAGES = {
  BAD_SIGNATURE: 'Cette place n\'a pas été émise par TwitNinf.',
  UNKNOWN: 'Code inconnu.',
  REVOKED: 'Place annulée.',
  EXPIRED: 'Place expirée.',
  ALREADY_USED: 'Place déjà utilisée.',
  WRONG_EVENT: 'Place valide, mais pour un autre événement.',
};

const REFUSAL_TO_SCAN_RESULT = {
  BAD_SIGNATURE: 'bad_signature',
  UNKNOWN: 'unknown',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  ALREADY_USED: 'already_used',
  WRONG_EVENT: 'wrong_event',
};

async function logScan(entry, transaction) {
  try {
    await EventPassScan.create(entry, { transaction });
  } catch (error) {
    // Le journal ne doit jamais faire échouer une entrée : quelqu'un attend
    // devant la porte.
    logger.warn('[Places] passage non journalisé:', error.message);
  }
}

/**
 * Lecture seule : dit ce que vaut une place sans la consommer.
 * C'est l'appel que fait l'invité pour regarder sa propre place, et le
 * contrôle « avant validation » quand l'équipe veut voir le nom d'abord.
 */
async function inspect(rawToken, { eventSlug } = {}) {
  const parsed = parseToken(rawToken);
  if (!parsed) {
    return { ok: false, reason: 'UNKNOWN', message: REFUSAL_MESSAGES.UNKNOWN };
  }
  if (parsed.signature && !signatureMatches(parsed.code, parsed.signature)) {
    return { ok: false, reason: 'BAD_SIGNATURE', message: REFUSAL_MESSAGES.BAD_SIGNATURE };
  }

  const pass = await EventPass.findOne({
    where: { code: formatCode(parsed.code) },
    include: [{ model: User, as: 'guest', attributes: ['id', 'username', 'full_name', 'avatar'] }],
  });
  if (!pass) {
    return { ok: false, reason: 'UNKNOWN', message: REFUSAL_MESSAGES.UNKNOWN };
  }
  if (eventSlug && pass.event_slug !== normalizeSlug(eventSlug)) {
    return {
      ok: false, reason: 'WRONG_EVENT', message: REFUSAL_MESSAGES.WRONG_EVENT, pass,
    };
  }

  const refusal = pass.refusalReason();
  return {
    ok: !refusal,
    reason: refusal,
    message: refusal ? REFUSAL_MESSAGES[refusal] : null,
    manual: parsed.manual,
    pass,
  };
}

/**
 * Validation d'une entrée. Consomme la place.
 *
 * Le verrou de ligne (`FOR UPDATE`) n'est pas une précaution théorique : à une
 * porte, deux membres de l'équipe scannent la même place à une seconde
 * d'intervalle parce que le premier n'a pas vu l'écran. Sans verrou, les deux
 * lisent `scans_count = 0` et laissent entrer deux personnes.
 */
async function redeem(rawToken, { scannedBy, deviceLabel, eventSlug } = {}) {
  const parsed = parseToken(rawToken);
  const device = sanitizeText(deviceLabel, 60);
  const attempt = String(rawToken || '').toUpperCase().slice(-48) || null;

  if (!parsed) {
    await logScan({
      result: 'unknown', code_attempt: attempt, scanned_by: scannedBy || null, device_label: device,
    });
    return { admitted: false, reason: 'UNKNOWN', message: REFUSAL_MESSAGES.UNKNOWN };
  }

  if (parsed.signature && !signatureMatches(parsed.code, parsed.signature)) {
    await logScan({
      result: 'bad_signature',
      code_attempt: formatCode(parsed.code),
      scanned_by: scannedBy || null,
      device_label: device,
    });
    return { admitted: false, reason: 'BAD_SIGNATURE', message: REFUSAL_MESSAGES.BAD_SIGNATURE };
  }

  const wantedSlug = eventSlug ? normalizeSlug(eventSlug) : null;

  return sequelize.transaction(async (transaction) => {
    const pass = await EventPass.findOne({
      where: { code: formatCode(parsed.code) },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (!pass) {
      await logScan({
        result: 'unknown',
        code_attempt: formatCode(parsed.code),
        scanned_by: scannedBy || null,
        device_label: device,
      }, transaction);
      return { admitted: false, reason: 'UNKNOWN', message: REFUSAL_MESSAGES.UNKNOWN };
    }

    const refuse = async (reason) => {
      await logScan({
        pass_id: pass.id,
        event_slug: pass.event_slug,
        code_attempt: pass.code,
        result: REFUSAL_TO_SCAN_RESULT[reason],
        scanned_by: scannedBy || null,
        device_label: device,
      }, transaction);
      return {
        admitted: false,
        reason,
        message: REFUSAL_MESSAGES[reason],
        pass: pass.toPublicJSON(),
      };
    };

    if (wantedSlug && pass.event_slug !== wantedSlug) return refuse('WRONG_EVENT');

    const refusal = pass.refusalReason();
    if (refusal) return refuse(refusal);

    const now = new Date();
    const scans = pass.scans_count + 1;
    await pass.update({
      scans_count: scans,
      status: scans >= pass.max_scans ? 'used' : 'valid',
      first_scanned_at: pass.first_scanned_at || now,
      last_scanned_at: now,
      scanned_by: scannedBy || null,
    }, { transaction });

    await logScan({
      pass_id: pass.id,
      event_slug: pass.event_slug,
      code_attempt: pass.code,
      result: 'admitted',
      scanned_by: scannedBy || null,
      device_label: device,
    }, transaction);

    return {
      admitted: true,
      manual: parsed.manual,
      remaining_scans: Math.max(0, pass.max_scans - scans),
      pass: pass.toPublicJSON(),
    };
  });
}

async function revoke(passId, { reason, actorId } = {}) {
  const pass = await EventPass.findByPk(passId);
  if (!pass) throw new EventPassError('Place introuvable.', 'NOT_FOUND', 404);

  await pass.update({
    status: 'revoked',
    revoked_reason: sanitizeText(reason, 160),
    metadata: { ...(pass.metadata || {}), revoked_by: actorId || null },
  });
  return pass;
}

/**
 * Remet une place annulée en circulation. `status` repart de l'état réel des
 * entrées : une place déjà passée redevient `used`, pas `valid` — sinon
 * l'annulation puis la restauration remettraient une entrée à zéro.
 */
async function restore(passId) {
  const pass = await EventPass.findByPk(passId);
  if (!pass) throw new EventPassError('Place introuvable.', 'NOT_FOUND', 404);

  await pass.update({
    status: pass.scans_count >= pass.max_scans ? 'used' : 'valid',
    revoked_reason: null,
  });
  return pass;
}

// ── Vues d'organisation ─────────────────────────────────────────────────────

/** Les événements ayant des places, avec leur compte, le plus récent devant. */
async function listEvents() {
  return sequelize.query(`
    SELECT
      event_slug,
      MAX(event_name)                                        AS event_name,
      MAX(event_date)                                        AS event_date,
      MAX(event_place)                                       AS event_place,
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE status = 'valid')::int          AS valid,
      COUNT(*) FILTER (WHERE status = 'used')::int           AS used,
      COUNT(*) FILTER (WHERE status = 'revoked')::int        AS revoked,
      MAX(created_at)                                        AS last_issued_at,
      MAX(last_scanned_at)                                   AS last_scanned_at
    FROM event_passes
    GROUP BY event_slug
    ORDER BY MAX(created_at) DESC
    LIMIT 100
  `, { type: sequelize.QueryTypes.SELECT });
}

async function listPasses({ eventSlug, status, search, limit = 100, offset = 0 } = {}) {
  const where = {};
  if (eventSlug) where.event_slug = normalizeSlug(eventSlug);
  if (status && EventPass.STATUSES.includes(status)) where.status = status;
  if (search) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [
      { code: { [Op.iLike]: term } },
      { guest_name: { [Op.iLike]: term } },
    ];
  }

  const { rows, count } = await EventPass.findAndCountAll({
    where,
    include: [{ model: User, as: 'guest', attributes: ['id', 'username', 'full_name', 'avatar'] }],
    order: [['serial', 'ASC']],
    limit: Math.min(Number.parseInt(limit, 10) || 100, 500),
    offset: Number.parseInt(offset, 10) || 0,
  });

  return { total: count, passes: rows };
}

/**
 * Tableau de bord d'un événement. Les refus sont comptés séparément : à une
 * porte, savoir que douze codes inconnus ont été présentés dans l'heure vaut
 * mieux que de le découvrir le lendemain.
 */
async function eventStats(eventSlug) {
  const slug = normalizeSlug(eventSlug);

  const [totals] = await sequelize.query(`
    SELECT
      COUNT(*)::int                                   AS total,
      COUNT(*) FILTER (WHERE status = 'valid')::int   AS valid,
      COUNT(*) FILTER (WHERE status = 'used')::int    AS used,
      COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked,
      COALESCE(SUM(scans_count), 0)::int              AS entries
    FROM event_passes WHERE event_slug = :slug
  `, { replacements: { slug }, type: sequelize.QueryTypes.SELECT });

  const refusals = await sequelize.query(`
    SELECT result, COUNT(*)::int AS count
    FROM event_pass_scans
    WHERE event_slug = :slug AND result <> 'admitted'
    GROUP BY result
  `, { replacements: { slug }, type: sequelize.QueryTypes.SELECT });

  const recent = await EventPassScan.findAll({
    where: { event_slug: slug },
    // `createdAt` et pas `created_at` : le modèle est `underscored`, l'attribut
    // porte le nom camelCase même si la colonne est en serpent.
    order: [['createdAt', 'DESC']],
    limit: 30,
    include: [
      { model: EventPass, as: 'pass', attributes: ['code', 'serial', 'guest_name', 'tier'] },
      { model: User, as: 'scanner', attributes: ['id', 'username'] },
    ],
  });

  return { event_slug: slug, ...totals, refusals, recent };
}

/**
 * Date telle qu'elle sera IMPRIMÉE. Formatée ici et pas dans le dessin : le
 * rendu ne doit pas avoir d'avis sur les fuseaux ni sur la langue.
 */
function formatEventDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const day = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short', day: 'numeric', month: 'short',
  }).format(date);

  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  if (!hasTime) return day;

  const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
    .format(date)
    .replace(':', 'h');
  return `${day} · ${time}`;
}

/** Ce dont le dessin a besoin, et rien de plus. */
function toArtModel(pass) {
  return {
    code: pass.code,
    serial: pass.serial,
    guest_name: pass.guest_name,
    tier: pass.tier,
    event_name: pass.event_name,
    event_date: formatEventDate(pass.event_date),
    event_place: pass.event_place,
  };
}

module.exports = {
  EventPassError,
  MAX_BATCH,
  createDoorToken,
  verifyDoorToken,
  formatEventDate,
  toArtModel,
  createBatch,
  inspect,
  redeem,
  revoke,
  restore,
  listEvents,
  listPasses,
  eventStats,
  // Exportés pour les routes de rendu et les tests.
  buildQrPayload,
  buildQrMatrix,
  buildPassUrl,
  buildToken,
  passOrigin,
  parseToken,
  signCode,
  signatureMatches,
  generateCode,
  formatCode,
  normalizeCode,
  normalizeSlug,
};
