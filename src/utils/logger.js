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

module.exports = logger;
