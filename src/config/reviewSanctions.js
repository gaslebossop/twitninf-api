'use strict';

/**
 * Sanctions que le LLM peut doser APRÈS un verdict communautaire
 * « non conforme ».
 *
 * Le jury décide du fond et son verdict est définitif. Le modèle ne peut donc
 * jamais répondre « aucune sanction » : il choisit seulement entre supprimer
 * le tweet, suspendre le compte pendant une durée précise, ou le bannir sans
 * terme.
 */
const SANCTIONS = Object.freeze({
  delete: { days: 0, deletesTweet: true },
  suspend: { days: undefined, deletesTweet: true },
  ban_definitif: { days: null, deletesTweet: true },
});

const SANCTION_KEYS = Object.freeze(Object.keys(SANCTIONS));

/** Une suspension temporaire est exprimée en jours entiers. */
const MIN_TEMPORARY_BAN_DAYS = 1;
const MAX_TEMPORARY_BAN_DAYS = 365;

const RESOLUTION_ACTION = Object.freeze({
  delete: 'delete',
  suspend: 'suspend',
  ban_definitif: 'ban',
});

function normalizeDurationDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days)) return null;
  if (days < MIN_TEMPORARY_BAN_DAYS || days > MAX_TEMPORARY_BAN_DAYS) return null;
  return days;
}

/**
 * Valide et normalise une décision brute du modèle.
 *
 * `duration_days` n'a de sens que pour `suspend`. Une valeur absente, décimale
 * ou hors limites rend la décision invalide afin de déclencher un nouvel essai
 * ou, à défaut, le repli sûr `delete`.
 */
function normalizeSanctionDecision(input) {
  const sanction = String(input?.sanction || '').trim();

  if (sanction === 'delete') {
    return {
      sanction,
      duration_days: null,
      days: 0,
      deletesTweet: true,
      label: 'suppression du tweet',
    };
  }

  if (sanction === 'ban_definitif') {
    return {
      sanction,
      duration_days: null,
      days: null,
      deletesTweet: true,
      label: 'bannissement définitif',
    };
  }

  if (sanction === 'suspend') {
    const days = normalizeDurationDays(input?.duration_days);
    if (days === null) return null;
    return {
      sanction,
      duration_days: days,
      days,
      deletesTweet: true,
      label: `suspension ${days} jour${days > 1 ? 's' : ''}`,
    };
  }

  return null;
}

function resolutionActionFor(input) {
  const decision = normalizeSanctionDecision(input);
  return decision ? RESOLUTION_ACTION[decision.sanction] : 'delete';
}

module.exports = {
  SANCTIONS,
  SANCTION_KEYS,
  RESOLUTION_ACTION,
  MIN_TEMPORARY_BAN_DAYS,
  MAX_TEMPORARY_BAN_DAYS,
  normalizeDurationDays,
  normalizeSanctionDecision,
  resolutionActionFor,
};
