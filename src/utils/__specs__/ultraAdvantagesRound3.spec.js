'use strict';

/**
 * Second lot de plafonds Ultra. Même garde que le premier lot : chaque borne
 * doit aller dans le sens de l'avantage, et aucune ne doit franchir la limite
 * de sûreté que son domaine s'était fixée.
 *
 * Ces tests ne vérifient pas « la valeur est 300 » — ça ne protège de rien et
 * ça casse au premier réglage. Ils vérifient les INVARIANTS : le sens de
 * l'inégalité, et les bornes qu'on s'interdit de dépasser.
 */

const { MAX_DURATION_SECONDS, MAX_DURATION_SECONDS_ULTRA } = require('../../services/tweetAudioService');
const {
  MAX_IMAGES_PER_TWEET,
  MAX_IMAGES_PER_TWEET_ULTRA,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_ULTRA,
  MAX_DIMENSION,
  MAX_DIMENSION_ULTRA,
} = require('../../services/tweetImageService');
const {
  SUPER_HEART_CAPS,
  SUPER_HEART_RENEW_DAYS,
  SUPER_HEART_RENEW_DAYS_ULTRA,
} = require('../superHeartHelpers');
const {
  USERNAME_RESERVATION_DAYS,
  USERNAME_RESERVATION_DAYS_ULTRA,
  PAID_CONTENT_MAX_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC_ULTRA,
  VELOCITY_ALERT_MULTIPLIER,
  VELOCITY_ALERT_MULTIPLIER_ULTRA,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS_ULTRA,
} = require('../../constants/premiumMarket');

describe('les plafonds Ultra vont tous dans le sens de l\'avantage', () => {
  test('publier : vocal plus long, plus d\'images, fichiers plus lourds, meilleure définition', () => {
    expect(MAX_DURATION_SECONDS_ULTRA).toBeGreaterThan(MAX_DURATION_SECONDS);
    expect(MAX_IMAGES_PER_TWEET_ULTRA).toBeGreaterThan(MAX_IMAGES_PER_TWEET);
    expect(MAX_UPLOAD_BYTES_ULTRA).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(MAX_DIMENSION_ULTRA).toBeGreaterThan(MAX_DIMENSION);
  });

  test('vendre : contenus plus chers, réservations plus longues', () => {
    expect(PAID_CONTENT_MAX_PRICE_TWC_ULTRA).toBeGreaterThan(PAID_CONTENT_MAX_PRICE_TWC);
    expect(USERNAME_RESERVATION_DAYS_ULTRA).toBeGreaterThan(USERNAME_RESERVATION_DAYS);
  });

  test('les seuils qui se franchissent VERS LE BAS vont bien vers le bas', () => {
    // Deux pièges d'inversion : être alerté plus tôt, c'est un multiplicateur
    // PLUS PETIT ; recharger plus vite, c'est un nombre de jours PLUS PETIT.
    expect(VELOCITY_ALERT_MULTIPLIER_ULTRA).toBeLessThan(VELOCITY_ALERT_MULTIPLIER);
    expect(SUPER_HEART_RENEW_DAYS_ULTRA).toBeLessThan(SUPER_HEART_RENEW_DAYS);
  });

  test('être protégé plus loin en arrière', () => {
    expect(IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS_ULTRA)
      .toBeGreaterThan(IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS);
  });
});

describe('les garde-fous qu\'un palier payant ne doit pas emporter', () => {
  test('le vocal Ultra tient encore dans la taille de fichier autorisée', () => {
    // ~1 Mo/minute en AAC voix : la durée ne doit jamais promettre un fichier
    // que la borne de téléversement refusera à l'arrivée.
    const { MAX_UPLOAD_BYTES: AUDIO_MAX } = require('../../services/tweetAudioService');
    const estimatedBytes = (MAX_DURATION_SECONDS_ULTRA / 60) * 1024 * 1024;
    expect(estimatedBytes).toBeLessThanOrEqual(AUDIO_MAX);
  });

  test('le Super Cœur reste une ressource RARE, même au palier du haut', () => {
    // Le pouvoir de mise en avant s'exerce sur le contenu d'autrui : sans
    // réserve bornée, le Spotlight deviendrait un classement payant.
    const perDay = SUPER_HEART_CAPS.ultra / SUPER_HEART_RENEW_DAYS_ULTRA;
    expect(perDay).toBeLessThan(10);
  });

  test('l\'alerte de décollage reste un signal, pas une notification permanente', () => {
    // En dessous de 2×, le « décollage » serait le bruit de fond normal.
    expect(VELOCITY_ALERT_MULTIPLIER_ULTRA).toBeGreaterThanOrEqual(2);
  });
});
