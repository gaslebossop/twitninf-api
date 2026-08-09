const consent = require('../consent');

describe('socle de consentement', () => {
  test('aucune finalite optionnelle n\'est accordee par defaut', () => {
    const defaults = consent.defaultOptionalPreferences();

    expect(Object.keys(defaults).sort()).toEqual([...consent.OPTIONAL_KEYS].sort());
    // Une case precochee ne vaut pas un consentement (art. 4.11 RGPD).
    expect(Object.values(defaults).every((value) => value === false)).toBe(true);
  });

  test('un compte qui n\'a jamais repondu doit etre interroge', () => {
    expect(consent.needsConsent({ consent_accepted_at: null, consent_version: null })).toBe(true);
  });

  test('un compte a jour n\'est pas reinterroge', () => {
    expect(consent.needsConsent({
      consent_accepted_at: new Date(),
      consent_version: consent.CONSENT_VERSION,
    })).toBe(false);
  });

  test('un changement de version reinterroge les comptes deja acceptes', () => {
    expect(consent.needsConsent({
      consent_accepted_at: new Date(),
      consent_version: 'version-precedente',
    })).toBe(true);
  });

  test('les finalites requises et optionnelles ne se chevauchent pas', () => {
    const overlap = consent.REQUIRED_KEYS.filter((key) => consent.OPTIONAL_KEYS.includes(key));

    expect(overlap).toEqual([]);
    expect(consent.ALL_KEYS).toHaveLength(consent.REQUIRED_KEYS.length + consent.OPTIONAL_KEYS.length);
  });

  test('aucune finalite optionnelle ne repose sur une autre base que le consentement', () => {
    // Une finalite refusable dont la base legale ne serait pas le consentement
    // serait un choix en trompe-l'oeil : le refus n'y changerait rien.
    expect(consent.OPTIONAL_PURPOSES.every((purpose) => purpose.legalBasis === 'consent')).toBe(true);
  });

  test('les traitements obligatoires ne sont jamais presentes comme un choix', () => {
    const noticeKeys = consent.MANDATORY_PROCESSING_NOTICES.map((notice) => notice.key);
    const asChoice = noticeKeys.filter((key) => consent.ALL_KEYS.includes(key));

    expect(asChoice).toEqual([]);
  });

  test('la version du socle designe la version des documents', () => {
    // Un accord enregistre doit pointer vers un texte identifiable : si les
    // deux versions divergent, la preuve de consentement ne designe plus rien.
    expect(consent.DOCUMENT_VERSION).toBe(consent.CONSENT_VERSION);
  });

  test('les finalites contractuelles renvoient a un document lisible', () => {
    // Faire accepter un document qu'on ne peut pas lire ne vaut rien.
    consent.REQUIRED_PURPOSES
      .filter((purpose) => purpose.legalBasis === 'contract')
      .forEach((purpose) => {
        expect(typeof purpose.documentPath).toBe('string');
        expect(purpose.documentPath.startsWith('/legal/')).toBe(true);
      });
  });

  test('le manifeste expose tout ce dont un client a besoin', () => {
    const manifest = consent.consentManifest();

    expect(manifest.version).toBe(consent.CONSENT_VERSION);
    expect(manifest.minimum_age).toBeGreaterThanOrEqual(13);
    expect(manifest.required.length).toBeGreaterThan(0);
    expect(manifest.optional.length).toBeGreaterThan(0);
    // Chaque finalite doit porter un libelle et une explication : un client ne
    // doit jamais avoir a inventer le texte affiche.
    [...manifest.required, ...manifest.optional, ...manifest.notices].forEach((entry) => {
      expect(typeof entry.title).toBe('string');
      expect(entry.title.length).toBeGreaterThan(0);
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
    });
  });
});
