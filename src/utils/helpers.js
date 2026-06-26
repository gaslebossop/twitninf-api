const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * Générer un ID de notification unique
 * Format: TWN-XXXX-XXXX-XXXX
 */
function generateIdNotif() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 4);
  const hash = crypto.createHash('md5').update(timestamp + random).digest('hex').substr(0, 4);
  
  return `TWN-${timestamp}-${random}-${hash}`.toUpperCase();
}

/**
 * Générer un token sécurisé
 */
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hasher une chaîne de caractères
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Valider un email
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Valider un numéro de téléphone
 */
function isValidPhone(phone) {
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone);
}

/**
 * Valider un nom d'utilisateur
 */
function isValidUsername(username) {
  const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
  return usernameRegex.test(username);
}

/**
 * Valider un mot de passe
 */
function isValidPassword(password) {
  // Au moins 8 caractères, 1 majuscule, 1 minuscule, 1 chiffre
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d@$!%*?&]{8,}$/;
  return passwordRegex.test(password);
}

/**
 * Formater un numéro de téléphone
 */
function formatPhoneNumber(phone) {
  // Supprimer tous les caractères non numériques
  const cleaned = phone.replace(/\D/g, '');
  
  // Ajouter le + si ce n'est pas déjà fait
  if (!phone.startsWith('+')) {
    return `+${cleaned}`;
  }
  
  return phone;
}

/**
 * Formater un nom d'utilisateur
 */
function formatUsername(username) {
  return username.toLowerCase().trim();
}

/**
 * Formater un email
 */
function formatEmail(email) {
  return email.toLowerCase().trim();
}

/**
 * Générer un slug à partir d'un texte
 */
function generateSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Générer un nom de fichier unique
 */
function generateUniqueFilename(originalName, extension) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  const slug = generateSlug(originalName);
  
  return `${slug}-${timestamp}-${random}.${extension}`;
}

/**
 * Formater une date pour l'affichage
 */
function formatDate(date, format = 'relative') {
  const now = new Date();
  const diff = now - date;
  
  if (format === 'relative') {
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (seconds < 60) return 'À l\'instant';
    if (minutes < 60) return `Il y a ${minutes} minute${minutes > 1 ? 's' : ''}`;
    if (hours < 24) return `Il y a ${hours} heure${hours > 1 ? 's' : ''}`;
    if (days < 7) return `Il y a ${days} jour${days > 1 ? 's' : ''}`;
    
    return date.toLocaleDateString('fr-FR');
  }
  
  return date.toLocaleDateString('fr-FR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Formater un nombre pour l'affichage
 */
function formatNumber(number) {
  if (number >= 1000000) {
    return (number / 1000000).toFixed(1) + 'M';
  }
  if (number >= 1000) {
    return (number / 1000).toFixed(1) + 'K';
  }
  return number.toString();
}

/**
 * Générer un code de vérification
 */
function generateVerificationCode(length = 6) {
  return Math.random().toString().substr(2, length);
}

/**
 * Vérifier si une chaîne est vide ou null
 */
function isEmpty(str) {
  return !str || str.trim().length === 0;
}

/**
 * Tronquer un texte
 */
function truncateText(text, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return text.substr(0, maxLength) + '...';
}

/**
 * Capitaliser la première lettre
 */
function capitalizeFirst(str) {
  if (isEmpty(str)) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Générer un ID court
 */
function generateShortId() {
  return Math.random().toString(36).substr(2, 8);
}

module.exports = {
  generateIdNotif,
  generateSecureToken,
  hashString,
  isValidEmail,
  isValidPhone,
  isValidUsername,
  isValidPassword,
  formatPhoneNumber,
  formatUsername,
  formatEmail,
  generateSlug,
  generateUniqueFilename,
  formatDate,
  formatNumber,
  generateVerificationCode,
  isEmpty,
  truncateText,
  capitalizeFirst,
  generateShortId
};
