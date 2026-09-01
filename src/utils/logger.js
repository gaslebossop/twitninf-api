const winston = require('winston');
const path = require('path');
const config = require('../config/config');

// Configuration des formats
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Configuration des transports
const transports = [
  // Console en développement
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }),
  
  // Fichier de logs généraux
  new winston.transports.File({
    filename: path.join(__dirname, '../logs/app.log'),
    format: logFormat,
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }),
  
  // Fichier d'erreurs
  new winston.transports.File({
    filename: path.join(__dirname, '../logs/error.log'),
    level: 'error',
    format: logFormat,
    maxsize: 5242880, // 5MB
    maxFiles: 5
  })
];

// Créer le logger
const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
  exitOnError: false
});

/**
 * Journalise une erreur ATTRAPÉE au bon niveau. Une condition métier ATTENDUE
 * — anti-fraude 409 (« transaction déjà exécutée », « en cours de vérification »,
 * rejeu), ou toute erreur porteuse d'un statut 4xx — part en `warn`, pas en
 * `error` : elle est déjà renvoyée au client sous forme de 4xx propre et n'a
 * rien à faire dans le flux d'erreurs serveur, qu'elle noyait (des centaines
 * d'entrées « ❌ … déjà été exécutée »). Une vraie panne (5xx, exception
 * inattendue) reste en `error`, avec sa pile.
 */
logger.caught = function caught(prefix, error) {
  const status = error?.httpStatus ?? error?.status;
  const expected = error?.name === 'TransactionRiskError' || (status >= 400 && status < 500);
  if (expected) {
    logger.warn(`${prefix} (attendu): ${error?.message || error}`);
  } else {
    logger.error(prefix, error);
  }
};

module.exports = logger;
