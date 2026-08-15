const {
  isAcceptedMimetype,
  sanitizeAudioUrl,
  sanitizeAudioDuration,
  MAX_DURATION_SECONDS,
} = require('../tweetAudioService');

describe('tweetAudioService — isAcceptedMimetype', () => {
  test('accepte les formats produits par expo-av', () => {
    expect(isAcceptedMimetype('audio/mp4')).toBe(true);
    expect(isAcceptedMimetype('audio/m4a')).toBe(true);
    expect(isAcceptedMimetype('audio/x-m4a')).toBe(true);
    expect(isAcceptedMimetype('audio/aac')).toBe(true);
  });

  test('rejette un type non audio ou absent', () => {
    expect(isAcceptedMimetype('video/mp4')).toBe(false);
    expect(isAcceptedMimetype('image/png')).toBe(false);
    expect(isAcceptedMimetype(undefined)).toBe(false);
    expect(isAcceptedMimetype('')).toBe(false);
  });
});

describe('tweetAudioService — sanitizeAudioUrl', () => {
  const origin = 'https://twitninf.duckdns.org';

  test('accepte une URL émise par cette API', () => {
    const url = `${origin}/static/audio/voice-1-123-abcd1234.m4a`;
    expect(sanitizeAudioUrl(url)).toBe(url);
  });

  test('rejette une URL vers un domaine tiers', () => {
    expect(sanitizeAudioUrl('https://evil.example.com/static/audio/x.m4a')).toBeNull();
  });

  test('rejette une tentative de traversée de chemin', () => {
    expect(sanitizeAudioUrl(`${origin}/static/audio/../avatars/x.m4a`)).toBeNull();
    expect(sanitizeAudioUrl(`${origin}/static/audio/sub/x.m4a`)).toBeNull();
  });

  test('rejette une entrée non-chaîne ou vide', () => {
    expect(sanitizeAudioUrl(null)).toBeNull();
    expect(sanitizeAudioUrl(undefined)).toBeNull();
    expect(sanitizeAudioUrl(42)).toBeNull();
  });
});

describe('tweetAudioService — sanitizeAudioDuration', () => {
  test('accepte une durée valide', () => {
    expect(sanitizeAudioDuration(12)).toBe(12);
    expect(sanitizeAudioDuration('30')).toBe(30);
  });

  test('arrondit et borne au plafond serveur', () => {
    expect(sanitizeAudioDuration(MAX_DURATION_SECONDS + 500)).toBe(MAX_DURATION_SECONDS);
    expect(sanitizeAudioDuration(12.6)).toBe(13);
  });

  test('renvoie null pour une durée invalide', () => {
    expect(sanitizeAudioDuration(0)).toBeNull();
    expect(sanitizeAudioDuration(-5)).toBeNull();
    expect(sanitizeAudioDuration('abc')).toBeNull();
    expect(sanitizeAudioDuration(undefined)).toBeNull();
  });
});
