const crypto = require('crypto');

/**
 * Preuve de travail du minage NF (app Windows) : un défi partagé par tous les
 * mineurs, le premier qui soumet un nonce dont le hash SHA-256 commence par
 * N zéros hexadécimaux remporte la récompense. Difficulté variable → récompense
 * exponentielle (plus rare = plus payant).
 */

const MIN_DIFFICULTY = 4;
const MAX_DIFFICULTY = 6;
const ROUND_TTL_MS = 10 * 60 * 1000; // un round expire après 10 min si personne ne le résout

function randomChallenge() {
  return crypto.randomBytes(16).toString('hex');
}

function randomDifficulty() {
  return MIN_DIFFICULTY + Math.floor(Math.random() * (MAX_DIFFICULTY - MIN_DIFFICULTY + 1));
}

/** Récompense exponentielle : x4 de NF par palier de difficulté au-dessus du minimum. */
function rewardForDifficulty(difficulty, baseReward) {
  const steps = Math.max(0, difficulty - MIN_DIFFICULTY);
  return Math.round(baseReward * Math.pow(4, steps) * 100) / 100;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Cible numérique (façon Bitcoin) plutôt qu'un simple compte de zéros hex :
 * seule façon d'appliquer un facteur de difficulté continu (ex. « 10x plus
 * dur » exactement) au lieu de paliers grossiers de x16 par nibble.
 * Un hash « passe » si les 32 premiers bits (8 hex) interprétés comme entier
 * sont strictement inférieurs à la cible — plus la cible est petite, plus
 * c'est dur.
 */
function targetForDifficulty(difficulty) {
  const attempts = Math.pow(16, difficulty);
  return Math.max(1, Math.floor(0x100000000 / attempts));
}

function scaleTarget(target, factor) {
  return Math.max(1, Math.floor(target / factor));
}

function hashMeetsTarget(hash, target) {
  if (typeof hash !== 'string' || hash.length < 8) return false;
  return parseInt(hash.slice(0, 8), 16) < target;
}

module.exports = {
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  ROUND_TTL_MS,
  randomChallenge,
  randomDifficulty,
  rewardForDifficulty,
  sha256Hex,
  targetForDifficulty,
  scaleTarget,
  hashMeetsTarget
};
