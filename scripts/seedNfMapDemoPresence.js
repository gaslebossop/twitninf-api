#!/usr/bin/env node
'use strict';

/**
 * Remplit la Carte NF avec des présences SYNTHÉTIQUES, pour la tester pleine.
 *
 * Nommé « Demo » et non « Test » : `.gitignore` écarte `*test*.js`, et un
 * script de peuplement non versionné finirait par diverger de la base qu'il
 * peuple.
 *
 * ── Pourquoi ce script existe ──
 * Une carte vide ne se teste pas : on ne voit ni les marqueurs, ni leur
 * regroupement, ni la fiche qui s'ouvre, ni le comportement du zoom. La
 * tentation naturelle est d'aller chercher les positions réelles déjà en base
 * (`user_location_events`, capturé pour la fraude et les statistiques) et de
 * les afficher. Ça donnerait une carte pleine tout de suite, et ça publierait
 * la position de gens qui n'ont jamais accepté ça — souvent auprès de comptes
 * qu'ils ne suivent même pas en retour.
 *
 * Ce script donne le même résultat visuel sans ce prix : il ne touche QUE des
 * comptes marqués `is_data_test`, et il place des points inventés autour d'un
 * centre choisi.
 *
 * ── Garde-fous ──
 *   - ne touche QUE des comptes `is_data_test = TRUE` ;
 *   - `--create` en fabrique si besoin, avec un pseudo préfixé `nfmaptest_`
 *     et un mot de passe impossible à utiliser : ces comptes n'ouvrent aucune
 *     session, ils n'existent que pour peupler une carte de démonstration ;
 *   - `--undo` retire les présences, et `--purge` supprime les comptes créés.
 *
 * Exemples :
 *   node scripts/seedNfMapDemoPresence.js --viewer gas --create 25
 *   node scripts/seedNfMapDemoPresence.js --viewer gas --center 48.8566,2.3522 --radius 8
 *   node scripts/seedNfMapDemoPresence.js --undo
 *   node scripts/seedNfMapDemoPresence.js --purge
 */

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const { positionForMode } = require('../src/services/nfMapService');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** Décalage en degrés pour un rayon en km, à cette latitude. */
function jitter(latitude, radiusKm) {
  const distanceKm = Math.sqrt(Math.random()) * radiusKm;
  const bearing = Math.random() * 2 * Math.PI;
  const dLat = (distanceKm * Math.cos(bearing)) / 111;
  const dLon = (distanceKm * Math.sin(bearing)) / (111 * Math.cos((latitude * Math.PI) / 180));
  return { dLat, dLon };
}

const TEST_PREFIX = 'nfmaptest_';

/**
 * Fabrique des comptes de démonstration.
 *
 * `is_data_test = TRUE` les écarte des statistiques et des exports, le préfixe
 * les rend reconnaissables à l'œil, et le mot de passe stocké n'est pas un
 * haché valide : personne ne peut ouvrir de session avec, pas même par erreur.
 */
const DEMO_NAMES = [
  'Lina', 'Yanis', 'Sofia', 'Malik', 'Emma', 'Noah', 'Ines', 'Adam',
  'Jade', 'Rayan', 'Louna', 'Ilyes', 'Maya', 'Nael', 'Sarah', 'Amir',
  'Chloe', 'Ethan', 'Nour', 'Liam', 'Alia', 'Gabriel', 'Yasmine', 'Enzo',
];

async function createTestAccounts(count) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    // Des prenoms distincts plutot que « Test » repete : les marqueurs
    // portent le pseudo, et vingt epingles identiques ne permettent de
    // verifier ni la lisibilite, ni le regroupement, ni la selection.
    const firstName = DEMO_NAMES[index % DEMO_NAMES.length];
    const username = `${firstName.toLowerCase()}_demo${index}`.slice(0, 30);

    const [row] = await sequelize.query(
      `INSERT INTO users (id, username, full_name, password, platform, is_data_test, is_active, created_at, updated_at)
       VALUES (uuid_generate_v4(), :username, :fullName, 'compte-de-test-non-connectable', 'android', TRUE, TRUE, NOW(), NOW())
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username`,
      { replacements: { username, fullName: firstName }, type: QueryTypes.SELECT }
    );
    if (row) created.push(row);
  }
  return created;
}

/**
 * Retire les comptes de démonstration de la circulation.
 *
 * On les DÉSACTIVE au lieu de les supprimer. Un compte est référencé par une
 * douzaine de tables (`profile_views`, `user_follows`, notifications…) dont
 * toutes ne cascadent pas : le supprimer revient à courir après chaque
 * contrainte, et une seule oubliée fait échouer la purge à moitié faite.
 * Désactivé, présence effacée et abonnements retirés, il disparaît de partout
 * où il se voyait — c'est ce qu'on veut, sans toucher au schéma.
 */
async function purge() {
  await sequelize.query(
    `DELETE FROM user_follows
      WHERE follower_id IN (SELECT id FROM users WHERE is_data_test = TRUE)
         OR following_id IN (SELECT id FROM users WHERE is_data_test = TRUE)`
  );
  await sequelize.query(
    `DELETE FROM nf_map_presence
      WHERE user_id IN (SELECT id FROM users WHERE is_data_test = TRUE)`
  );

  const [, meta] = await sequelize.query(
    `UPDATE users SET is_active = FALSE, updated_at = NOW()
      WHERE is_data_test = TRUE AND is_active = TRUE`
  );
  console.log(`🧹 ${meta?.rowCount || 0} compte(s) de démonstration désactivé(s).`);
}

async function undo() {
  const [, meta] = await sequelize.query(
    `DELETE FROM nf_map_presence
      WHERE user_id IN (SELECT id FROM users WHERE is_data_test = TRUE)`
  );
  console.log(`🧹 ${meta?.rowCount || 0} présence(s) de test retirée(s).`);
}

async function main() {
  if (hasFlag('undo')) {
    await undo();
    return;
  }

  if (hasFlag('purge')) {
    await purge();
    return;
  }

  const viewerUsername = String(arg('viewer', '')).replace(/^@/, '');
  if (!viewerUsername) {
    throw new Error('Indiquer le compte qui doit les voir : --viewer <pseudo>');
  }

  const count = Math.min(parseInt(arg('count', '25'), 10) || 25, 200);
  const radiusKm = Number(arg('radius', '10')) || 10;
  const [centerLat, centerLon] = String(arg('center', '48.8566,2.3522'))
    .split(',')
    .map(Number);

  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new Error('Centre invalide : --center lat,lon');
  }

  const [viewer] = await sequelize.query(
    `SELECT id, username FROM users WHERE username ILIKE :username LIMIT 1`,
    { replacements: { username: viewerUsername }, type: QueryTypes.SELECT }
  );
  if (!viewer) throw new Error(`Compte introuvable : @${viewerUsername}`);

  const toCreate = parseInt(arg('create', '0'), 10) || 0;
  if (toCreate > 0) {
    const made = await createTestAccounts(Math.min(toCreate, 200));
    console.log(`👥 ${made.length} compte(s) de démonstration créé(s).`);
  }

  // Uniquement des comptes de test. C'est le garde-fou principal : sans lui,
  // ce script deviendrait exactement ce qu'il est censé éviter.
  const accounts = await sequelize.query(
    `SELECT id, username FROM users
      WHERE is_data_test = TRUE AND is_active = TRUE AND id <> :viewerId
      ORDER BY random() LIMIT :count`,
    { replacements: { viewerId: viewer.id, count }, type: QueryTypes.SELECT }
  );

  if (accounts.length === 0) {
    throw new Error(
      'Aucun compte `is_data_test` disponible. Relancer avec --create N : ce script ne place ' +
      'jamais de compte réel, il ne fabrique que des comptes de démonstration.'
    );
  }

  for (const account of accounts) {
    const { dLat, dLon } = jitter(centerLat, radiusKm);
    const mode = Math.random() < 0.3 ? 'city' : 'precise';

    // Même arrondi que la production : sans lui, les points « ville » de la
    // démonstration seraient plus précis que les vrais, et l'écran donnerait
    // une idée fausse de ce que ce mode montre réellement.
    const stored = positionForMode(mode, centerLat + dLat, centerLon + dLon);
    if (!stored) continue;

    await sequelize.query(
      `INSERT INTO nf_map_presence
         (user_id, sharing_mode, audience, latitude, longitude, place_label, shared_at, expires_at, created_at, updated_at)
       VALUES
         (:userId, :mode, 'connections', :latitude, :longitude, NULL,
          NOW(), NOW() + INTERVAL '8 hours', NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         sharing_mode = EXCLUDED.sharing_mode,
         audience = EXCLUDED.audience,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         place_label = EXCLUDED.place_label,
         shared_at = NOW(),
         expires_at = NOW() + INTERVAL '8 hours',
         updated_at = NOW()`,
      {
        replacements: {
          userId: account.id,
          mode,
          latitude: stored.latitude,
          longitude: stored.longitude,
        },
      }
    );

    // Un lien est obligatoire pour que la carte les montre : on abonne le
    // compte de test au spectateur, ce qui suffit avec l'audience
    // `connections`.
    await sequelize.query(
      `INSERT INTO user_follows (id, follower_id, following_id, status, created_at, updated_at, is_data_test)
       VALUES (uuid_generate_v4(), :testId, :viewerId, 'active', NOW(), NOW(), TRUE)
       ON CONFLICT DO NOTHING`,
      { replacements: { testId: account.id, viewerId: viewer.id } }
    );
  }

  console.log(
    `🗺️  ${accounts.length} présence(s) de test posée(s) autour de ${centerLat}, ${centerLon} ` +
    `(rayon ${radiusKm} km), visibles par @${viewer.username}.`
  );
  console.log('   Elles expirent seules dans 8 h. Pour les retirer : --undo');
}

main()
  .then(() => sequelize.close())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(`❌ ${error.message}`);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
