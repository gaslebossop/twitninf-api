const test = require('node:test');
const assert = require('node:assert');

/**
 * Le report de la localisation de session vers la Carte NF.
 *
 * ── Ce que ce fichier protège ─────────────────────────────────────────────
 * `authService.recordSessionLocation` pousse désormais la position sur la
 * carte, pour que quelqu'un qui n'ouvre jamais l'onglet y apparaisse quand
 * même. C'est pratique, et c'est aussi le genre d'ajout qui transforme une
 * donnée collectée pour l'ANTIFRAUDE en donnée publiée à d'autres
 * utilisateurs.
 *
 * La seule chose qui l'en empêche est le mode de partage relu en base par
 * `updatePosition`. Si quelqu'un « optimise » un jour ce contrôle — en passant
 * le mode depuis l'appelant, en court-circuitant la lecture, en ajoutant un
 * chemin rapide — la fuite serait totale et silencieuse : aucune erreur,
 * aucun test rouge, juste des positions publiées sans consentement.
 *
 * D'où ces assertions, qui portent sur le CONTRAT et pas sur l'implémentation.
 */

const nfMap = require('../nfMapService');

/** Faux `sequelize` : on n'observe que ce qui est demandé à la base. */
function fakeSequelize(settingsRow) {
  const queries = [];
  return {
    queries,
    query: async (sql, options) => {
      queries.push({ sql, replacements: options?.replacements });
      // `getSettings` interroge avec `type: QueryTypes.SELECT`, qui renvoie les
      // LIGNES directement — pas le couple [résultat, métadonnées] du mode par
      // défaut. Un faux qui se trompe là-dessus fait passer des tests pour de
      // mauvaises raisons.
      if (options?.type === 'SELECT') {
        return settingsRow ? [settingsRow] : [];
      }
      return [[]];
    },
  };
}

const GHOST = {
  sharing_mode: 'ghost',
  audience: 'friends',
  latitude: null,
  longitude: null,
  place_label: null,
  shared_at: null,
  expires_at: null,
};

const SHARING = {
  sharing_mode: 'city',
  audience: 'friends',
  latitude: 48.85,
  longitude: 2.35,
  place_label: 'Paris',
  shared_at: new Date(),
  expires_at: new Date(Date.now() + 3600e3),
};

test('un compte en mode fantome n est JAMAIS positionne', async () => {
  const db = fakeSequelize(GHOST);

  const result = await nfMap.updatePosition(db, 'user-1', {
    latitude: 48.8566,
    longitude: 2.3522,
  });

  assert.strictEqual(result.stored, false);
  assert.strictEqual(result.reason, 'ghost');

  // Et surtout : aucune ECRITURE n'a ete tentee, sous quelque forme que ce
  // soit. On teste l'absence d'ecriture, pas l'absence d'un mot-cle precis :
  // la requete est passee d'UPDATE a INSERT ... ON CONFLICT en cours de route,
  // et une assertion calee sur la syntaxe serait devenue verte a tort.
  const writes = db.queries.filter((q) => /INSERT INTO|UPDATE/i.test(q.sql));
  assert.strictEqual(writes.length, 0, 'aucune ecriture ne doit partir en mode fantome');
});

test('un compte qui partage est positionne ET remis en ligne', async () => {
  const db = fakeSequelize(SHARING);

  const result = await nfMap.updatePosition(db, 'user-2', {
    latitude: 48.8566,
    longitude: 2.3522,
  });

  assert.strictEqual(result.stored, true);

  const write = db.queries.find((q) => /INSERT INTO nf_map_presence|UPDATE nf_map_presence/i.test(q.sql));
  assert.ok(write, 'une ecriture doit partir');
  // La ligne doit pouvoir etre CREEE : la plupart des comptes n'en ont aucune
  // depuis que le mode par defaut est « ville ». Un simple UPDATE ne toucherait
  // rien et personne n'apparaitrait jamais.
  assert.match(write.sql, /ON CONFLICT/i);
  // `expires_at` repousse est ce que la carte lit comme « en ligne » : sans
  // lui, la position serait ecrite mais la personne resterait invisible.
  assert.match(write.sql, /expires_at\s*=\s*NOW\(\)/i);
  assert.match(write.sql, /shared_at\s*=\s*NOW\(\)/i);
});

test('le mode « ville » degrade la precision transmise', async () => {
  const db = fakeSequelize(SHARING);

  const result = await nfMap.updatePosition(db, 'user-3', {
    latitude: 48.8566,
    longitude: 2.3522,
  });

  // On ne verifie pas une valeur precise — la grille peut changer — mais le
  // fait que la position PUBLIEE ne soit pas la position transmise.
  assert.notStrictEqual(result.latitude, 48.8566);
  assert.notStrictEqual(result.longitude, 2.3522);
});

test('une position invalide est refusee', async () => {
  const db = fakeSequelize(SHARING);

  const result = await nfMap.updatePosition(db, 'user-4', {
    latitude: 999,
    longitude: 2.3522,
  });

  assert.strictEqual(result.stored, false);
  assert.strictEqual(result.reason, 'invalid_position');
});
