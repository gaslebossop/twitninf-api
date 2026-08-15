/*
 * `test` est celui de JEST, pas celui de `node:test`.
 *
 * Ce fichier importait `node:test` alors qu'il est le seul du depot dans ce
 * cas — tous les autres specs sont en Jest. Consequence : `npm test` ne
 * voyait aucun test ici et rapportait « Your test suite must contain at least
 * one test », c'est-a-dire un ECHEC permanent qui ne disait rien de l'etat du
 * code. Le fichier passait ou echouait uniquement sous `node --test`, que
 * personne ne lance.
 *
 * Ca n'a rien d'anecdotique ici : ce spec est declare comme le garde-fou
 * contre une publication de positions sans consentement. Il a laisse passer
 * une contradiction entre le code et lui-meme sans qu'aucune CI ne rougisse.
 *
 * `node:assert` reste utilise tel quel : il fonctionne sous Jest.
 */
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

test('un compte qui partage est positionne, avec une echeance', async () => {
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
  assert.match(write.sql, /shared_at\s*=\s*NOW\(\)/i);

  /*
   * L'echeance est POSEE, et ce test le protege dans ce sens.
   *
   * Il exigeait l'inverse — « aucune echeance ne doit etre posee » — du temps
   * ou l'expiration etait desactivee. Le sens est retabli : sur une carte qui
   * repond a « ou sont mes amis maintenant », une position vieille de
   * plusieurs semaines n'est pas une information, et la table deviendrait un
   * historique de deplacements que personne n'a accepte de tenir.
   *
   * C'est donc une assertion de VIE PRIVEE autant que de comportement. La
   * relacher redonne des positions eternelles, sans rien casser d'autre :
   * exactement le genre de regression qui passe inapercue.
   */
  assert.match(
    write.sql,
    /expires_at\s*=\s*NOW\(\)\s*\+/i,
    'chaque envoi doit reposer une echeance'
  );
  // Le delai vient d'une constante, pas d'une valeur en dur dans le SQL : on
  // verifie donc qu'il est bien transmis, et qu'il est strictement positif —
  // un `ttlHours` a 0 rendrait la position expiree a l'instant meme.
  assert.ok(
    write.replacements.ttlHours > 0,
    'le delai d expiration doit etre transmis et non nul'
  );
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
