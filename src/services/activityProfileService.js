const { QueryTypes } = require('sequelize');
const logger = require('../utils/logger');

/**
 * Apprentissage des heures actives, pour la relance quotidienne.
 *
 * Ce service APPREND, il ne décide de rien : il remplit `slots` dans
 * `user_nudge_state`, et `dailyNudgeService` s'en sert ensuite. La séparation
 * compte, parce que les deux ont des rythmes opposés — l'apprentissage tourne
 * une fois par nuit sur toute la base, la décision toutes les quinze minutes
 * sur une poignée de lignes.
 *
 * ── Ce qui a motivé la forme de cet apprentissage ──────────────────────
 * Le calendrier précédent (12 h / 16 h / 20 h, en dur dans l'app) avait été
 * posé à l'intuition. Mesuré sur 28 jours, le pic réel d'audience est à
 * MINUIT et 1 h du matin ; 12 h n'est même pas dans les huit premières
 * heures. D'où le choix d'apprendre plutôt que de choisir.
 *
 * ── Pourquoi semaine/week-end et pas sept jours ───────────────────────
 * Découper par jour de la semaine paraît plus fin, mais avec la volumétrie
 * réelle (quelques dizaines d'utilisateurs actifs) chaque case tomberait à
 * quelques dizaines d'événements. On présenterait du bruit comme une
 * préférence. Deux régimes suffisent, et ils se remplissent.
 */

const PARIS_TIMEZONE = 'Europe/Paris';

/** Fenêtre d'apprentissage. Quatre semaines pleines : chaque jour de la
 *  semaine y apparaît quatre fois, ce qui suffit à lisser un jour creux. */
const LEARNING_WINDOW_DAYS = 28;

/**
 * En dessous, l'histogramme personnel n'est pas crédible et on sert
 * l'histogramme global. Trente événements, c'est l'ordre de grandeur d'une
 * poignée de sessions : assez pour qu'un pic ne soit pas un accident, pas
 * assez pour être exigeant avec une base petite.
 */
const MIN_EVENTS_FOR_PERSONAL = 30;

/** Deux relances par jour au maximum : deux créneaux appris. */
const SLOTS_PER_REGIME = 2;

/**
 * Écart minimal entre deux créneaux retenus, en heures.
 *
 * Sans lui, les deux meilleures heures d'une personne seraient presque
 * toujours adjacentes (23 h et minuit pour un noctambule) et les deux
 * relances tomberaient dans la même session — donc une seule aurait un
 * effet, et la seconde serait vécue comme du harcèlement.
 */
const MIN_SLOT_GAP_HOURS = 5;

/**
 * Événements écartés de l'apprentissage : ils sont émis par l'appareil, pas
 * par la personne. Les compter placerait les créneaux sur les heures où le
 * système se réveille tout seul, ce qui est exactement le contraire du but.
 */
const BACKGROUND_ACTIONS = ['system_stats_sync', 'device_motion_noise'];

/** Distance circulaire entre deux heures : 23 h et 1 h sont à 2 h d'écart. */
function hourDistance(a, b) {
  const raw = Math.abs(a - b);
  return Math.min(raw, 24 - raw);
}

/**
 * Retient les meilleures heures d'un histogramme, en imposant un écart
 * minimal entre elles.
 *
 * @param {Record<number, number>} histogram - poids par heure (0-23)
 * @returns {number[]} heures retenues, dans l'ordre décroissant de poids
 */
function pickSlots(histogram, count = SLOTS_PER_REGIME, minGap = MIN_SLOT_GAP_HOURS) {
  const ranked = Object.entries(histogram || {})
    .map(([hour, weight]) => ({ hour: Number(hour), weight: Number(weight) || 0 }))
    .filter((entry) => entry.weight > 0 && Number.isInteger(entry.hour))
    .sort((a, b) => b.weight - a.weight || a.hour - b.hour);

  const picked = [];
  for (const entry of ranked) {
    if (picked.length >= count) break;
    if (picked.every((hour) => hourDistance(hour, entry.hour) >= minGap)) {
      picked.push(entry.hour);
    }
  }
  return picked;
}

/**
 * Range des lignes `{ user_id, regime, hour, events }` en histogrammes par
 * utilisateur. Fonction pure : c'est elle qu'on teste, pas le SQL.
 */
function foldRows(rows) {
  const byUser = new Map();
  for (const row of rows || []) {
    const userId = String(row.user_id);
    if (!byUser.has(userId)) {
      byUser.set(userId, { weekday: {}, weekend: {}, total: 0 });
    }
    const entry = byUser.get(userId);
    const regime = row.regime === 'weekend' ? 'weekend' : 'weekday';
    const events = Number(row.events) || 0;
    entry[regime][Number(row.hour)] = events;
    entry.total += events;
  }
  return byUser;
}

/**
 * Construit les créneaux d'un utilisateur, avec repli sur le global.
 *
 * Le repli est par RÉGIME et non par personne : quelqu'un qui n'ouvre l'app
 * que le week-end a un histogramme de semaine vide, et mérite quand même ses
 * créneaux de week-end appris.
 */
function buildSlots(personal, globalSlots) {
  if (!personal || personal.total < MIN_EVENTS_FOR_PERSONAL) {
    return { slots: globalSlots, source: 'global', sampleEvents: personal?.total || 0 };
  }

  const weekday = pickSlots(personal.weekday);
  const weekend = pickSlots(personal.weekend);

  return {
    slots: {
      weekday: weekday.length ? weekday : globalSlots.weekday,
      weekend: weekend.length ? weekend : globalSlots.weekend,
    },
    source: 'personal',
    sampleEvents: personal.total,
  };
}

/**
 * Histogramme de toute la population, en utilisateurs distincts par heure.
 *
 * Distincts et non événements bruts : une seule personne très bavarde une
 * nuit déplacerait sinon le créneau global de tout le monde.
 */
async function computeGlobalSlots() {
  const { sequelize } = require('../models');

  const rows = await sequelize.query(
    `SELECT CASE WHEN EXTRACT(DOW FROM timestamp AT TIME ZONE :tz) IN (0, 6)
                 THEN 'weekend' ELSE 'weekday' END        AS regime,
            EXTRACT(HOUR FROM timestamp AT TIME ZONE :tz)::int AS hour,
            COUNT(DISTINCT user_id)::int                  AS events
       FROM user_behavior_data
      WHERE timestamp > NOW() - ((:days)::int * INTERVAL '1 day')
        AND action_type NOT IN (:excluded)
      GROUP BY 1, 2`,
    {
      replacements: { tz: PARIS_TIMEZONE, days: LEARNING_WINDOW_DAYS, excluded: BACKGROUND_ACTIONS },
      type: QueryTypes.SELECT,
    }
  );

  const histograms = { weekday: {}, weekend: {} };
  for (const row of rows) {
    histograms[row.regime === 'weekend' ? 'weekend' : 'weekday'][Number(row.hour)] = Number(row.events);
  }

  const slots = {
    weekday: pickSlots(histograms.weekday),
    weekend: pickSlots(histograms.weekend),
  };

  // Une base vide rendrait deux listes vides, et le planificateur
  // n'enverrait jamais rien sans le dire. Mieux vaut un repli explicite.
  if (!slots.weekday.length) slots.weekday = [19, 13];
  if (!slots.weekend.length) slots.weekend = slots.weekday;

  return slots;
}

/**
 * Recalcule les créneaux de tous les utilisateurs joignables.
 *
 * « Joignables » = qui ont au moins un abonnement Web Push. Calculer pour les
 * 3 500 comptes de la base serait du travail jeté : la quasi-totalité vient
 * de créations scriptées et ne peut recevoir aucune notification. Un nouvel
 * abonné reçoit sa ligne d'état dès `POST /api/push/subscribe`, avec les
 * créneaux globaux ; cette fonction ne fait que les remplacer par les siens
 * dès qu'il a produit assez d'événements.
 */
async function recomputeProfiles() {
  const { sequelize, UserNudgeState } = require('../models');

  const globalSlots = await computeGlobalSlots();

  const rows = await sequelize.query(
    `SELECT b.user_id,
            CASE WHEN EXTRACT(DOW FROM b.timestamp AT TIME ZONE :tz) IN (0, 6)
                 THEN 'weekend' ELSE 'weekday' END             AS regime,
            EXTRACT(HOUR FROM b.timestamp AT TIME ZONE :tz)::int AS hour,
            COUNT(*)::int                                      AS events
       FROM user_behavior_data b
      WHERE b.timestamp > NOW() - ((:days)::int * INTERVAL '1 day')
        AND b.action_type NOT IN (:excluded)
        AND EXISTS (SELECT 1 FROM web_push_subscriptions s WHERE s.user_id = b.user_id)
      GROUP BY 1, 2, 3`,
    {
      replacements: { tz: PARIS_TIMEZONE, days: LEARNING_WINDOW_DAYS, excluded: BACKGROUND_ACTIONS },
      type: QueryTypes.SELECT,
    }
  );

  const perUser = foldRows(rows);

  // Les abonnés sans aucun événement n'apparaissent pas ci-dessus et doivent
  // pourtant recevoir les créneaux globaux : ce sont précisément les
  // nouveaux, ceux qu'il est le plus utile de relancer.
  const subscribers = await sequelize.query(
    'SELECT DISTINCT user_id FROM web_push_subscriptions',
    { type: QueryTypes.SELECT }
  );

  const now = new Date();
  let personal = 0;
  let global = 0;

  for (const { user_id: userId } of subscribers) {
    const built = buildSlots(perUser.get(String(userId)), globalSlots);
    if (built.source === 'personal') personal += 1; else global += 1;

    await UserNudgeState.upsert({
      user_id: userId,
      slots: built.slots,
      slots_source: built.source,
      sample_events: built.sampleEvents,
      slots_computed_at: now,
    });
  }

  logger.info(
    `[relance] créneaux recalculés — ${personal} personnalisés, ${global} globaux `
    + `(global: semaine ${globalSlots.weekday.join('h, ')}h / week-end ${globalSlots.weekend.join('h, ')}h)`
  );

  return { personal, global, globalSlots };
}

module.exports = {
  recomputeProfiles,
  computeGlobalSlots,
  // Exportés pour les tests : ce sont les seules parties où une erreur
  // passerait inaperçue en production.
  pickSlots,
  foldRows,
  buildSlots,
  hourDistance,
  MIN_EVENTS_FOR_PERSONAL,
  MIN_SLOT_GAP_HOURS,
  SLOTS_PER_REGIME,
};
