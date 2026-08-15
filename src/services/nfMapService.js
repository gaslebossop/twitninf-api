'use strict';

/**
 * 🗺️ Carte NF — présence partagée sur une carte.
 *
 * Une carte de gens est une base de données de déplacements. Tout ce fichier
 * découle de ce constat, et de quatre règles qui ne sont pas négociables :
 *
 *   1. **Rien par défaut.** L'absence de ligne, comme le mode `ghost`, veut
 *      dire « invisible ». Il faut un geste explicite pour apparaître, jamais
 *      pour disparaître.
 *   2. **On ne stocke que ce qui est montré.** En mode `city`, la position est
 *      arrondie AVANT écriture. La position exacte n'entre pas en base : elle
 *      ne peut donc pas fuiter par une requête, une sauvegarde ou un bug.
 *   3. **Ça s'efface tout seul.** Une position expire au bout de huit heures.
 *      Une carte sans expiration devient un historique de déplacements, ce que
 *      personne n'a demandé en activant le partage.
 *   4. **Un lien obligatoire.** Par défaut, les comptes liés dans un sens ou
 *      dans l'autre — la définition d'« ami » retenue pour le produit. Le
 *      réglage peut être resserré aux seuls abonnements réciproques, jamais
 *      élargi au-delà : une position visible de tous n'est pas une carte entre
 *      proches, c'est une publication.
 *
 * Ces quatre règles décrivent ce qui est PARTAGÉ. Rien ici ne va chercher une
 * position ailleurs : `user_location_events` est collecté pour la fraude et
 * les statistiques, et alimenter la carte avec cette table publierait la
 * position de comptes qui n'ont jamais accepté d'apparaître.
 */

const { QueryTypes } = require('sequelize');

const SHARING_MODES = ['ghost', 'city', 'precise'];

/**
 * Qui peut me voir, du plus fermé au plus ouvert :
 *   - `mutuals`     : on se suit dans les deux sens ;
 *   - `followers`   : ceux qui me suivent ;
 *   - `connections` : n'importe quel lien, dans un sens ou dans l'autre.
 *
 * Dans tous les cas il FAUT un lien : la carte ne montre jamais un inconnu.
 * Le choix appartient à la personne qui se montre, jamais à celle qui regarde.
 */
const AUDIENCES = ['mutuals', 'followers', 'connections'];

/** Au-delà, la position n'est plus montrée — voir la règle 3. */
/**
 * Conservée à 0 pour compatibilité d'import : la présence n'expire plus.
 * Voir `purgeExpired` et `nearby`.
 */
const PRESENCE_TTL_HOURS = 0;

/**
 * Arrondi du mode « ville » : ~0,05° ≈ 5,5 km en latitude. Assez pour situer
 * quelqu'un dans son agglomération, trop grossier pour désigner une rue.
 *
 * L'arrondi est déterministe et non un bruit aléatoire : un bruit retiré à
 * chaque envoi se moyenne, et recouper quelques positions successives
 * redonnerait le point exact.
 */
const CITY_GRID_DEGREES = 0.05;

/** Rectangle maximal servi en une fois, pour ne pas aspirer la carte entière. */
const MAX_VIEWPORT_DEGREES = 12;
const MAX_RESULTS = 200;

function roundToGrid(value, grid) {
  return Math.round(value / grid) * grid;
}

function isValidLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * Position telle qu'elle sera STOCKÉE, selon le mode choisi.
 * `null` si rien ne doit être stocké.
 */
function positionForMode(mode, latitude, longitude) {
  if (mode === 'ghost') return null;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;

  if (mode === 'city') {
    return {
      latitude: Number(roundToGrid(latitude, CITY_GRID_DEGREES).toFixed(6)),
      longitude: Number(roundToGrid(longitude, CITY_GRID_DEGREES).toFixed(6)),
    };
  }

  return {
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
  };
}

/**
 * Réglages de l'appelant.
 *
 * ── Le défaut est « ville », plus « fantôme » ─────────────────────────────
 * Un compte sans ligne n'a jamais ouvert les réglages de la carte. Il était
 * jusqu'ici invisible, ce qui rendait la carte vide pour presque tout le
 * monde : au moment du changement, 3 502 comptes sur 3 550 n'avaient aucune
 * ligne, et AUCUN n'avait explicitement choisi « fantôme ».
 *
 * Le défaut est donc « ville » : visible, mais à la précision d'une grille de
 * quartier — jamais la position exacte. Celle-ci reste un choix délibéré, que
 * 37 comptes ont fait.
 *
 * ⚠️ C'est un changement de VISIBILITÉ pour des gens qui n'ont rien demandé.
 * Il est assumé et décidé côté produit ; il ne touche aucun choix explicite,
 * puisqu'il n'en existait aucun dans l'autre sens.
 */
async function getSettings(sequelize, userId) {
  const [row] = await sequelize.query(
    `SELECT sharing_mode, audience, latitude, longitude, place_label, shared_at, expires_at
       FROM nf_map_presence WHERE user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );

  if (!row) {
    return {
      sharing_mode: 'city',
      audience: 'connections',
      shared_at: null,
      expires_at: null,
      place_label: null,
      latitude: null,
      longitude: null,
      is_live: false,
    };
  }

  return {
    sharing_mode: row.sharing_mode,
    audience: row.audience,
    place_label: row.place_label,
    shared_at: row.shared_at,
    expires_at: row.expires_at,
    /**
     * SA PROPRE position — jamais celle de quelqu'un d'autre.
     *
     * Cette route est authentifiée et ne lit que la ligne de l'appelant : lui
     * rendre sa position ne publie rien, il vient de l'envoyer lui-même.
     *
     * C'est ce qui permet à un client qui n'a pas de GPS — l'app Windows — de
     * se placer sur la carte : il reprend la dernière position poussée depuis
     * le téléphone. Sans ça, un ordinateur de bureau n'a aucun moyen de savoir
     * où est son utilisateur, et l'épingle « Toi » n'existerait pas chez lui.
     *
     * En mode « ville » c'est déjà la position arrondie qui est stockée — voir
     * `positionForMode` : la précision exacte n'a même pas été écrite.
     */
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    // Une position connue et un mode non fantome suffisent : elle ne se
    // perime plus. `shared_at` reste disponible pour dire DEPUIS QUAND, ce
    // qui est une information d'affichage, pas de visibilite.
    is_live: row.sharing_mode !== 'ghost' && row.latitude !== null,
  };
}

/**
 * Change le mode ou le public.
 *
 * Repasser en `ghost` EFFACE la position au lieu de la masquer. Se rendre
 * invisible doit retirer la donnée, sinon « invisible » ne veut dire qu'« pas
 * affiché pour l'instant ».
 */
async function updateSettings(sequelize, userId, { sharing_mode: mode, audience }) {
  if (mode !== undefined && !SHARING_MODES.includes(mode)) {
    throw new Error('Mode de partage inconnu');
  }
  if (audience !== undefined && !AUDIENCES.includes(audience)) {
    throw new Error('Public inconnu');
  }

  await sequelize.query(
    `INSERT INTO nf_map_presence (user_id, sharing_mode, audience, created_at, updated_at)
     VALUES (:userId, COALESCE(:mode, 'city'), COALESCE(:audience, 'connections'), NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       sharing_mode = COALESCE(:mode, nf_map_presence.sharing_mode),
       audience = COALESCE(:audience, nf_map_presence.audience),
       latitude = CASE WHEN COALESCE(:mode, nf_map_presence.sharing_mode) = 'ghost'
                       THEN NULL ELSE nf_map_presence.latitude END,
       longitude = CASE WHEN COALESCE(:mode, nf_map_presence.sharing_mode) = 'ghost'
                        THEN NULL ELSE nf_map_presence.longitude END,
       place_label = CASE WHEN COALESCE(:mode, nf_map_presence.sharing_mode) = 'ghost'
                          THEN NULL ELSE nf_map_presence.place_label END,
       expires_at = CASE WHEN COALESCE(:mode, nf_map_presence.sharing_mode) = 'ghost'
                         THEN NULL ELSE nf_map_presence.expires_at END,
       updated_at = NOW()`,
    { replacements: { userId, mode: mode ?? null, audience: audience ?? null } }
  );

  return getSettings(sequelize, userId);
}

/**
 * Enregistre une position envoyée par l'application.
 *
 * Le mode est relu EN BASE et non pris dans la requête : un client qui
 * enverrait `mode: 'precise'` alors que son propriétaire a choisi « ville »
 * contournerait sinon son propre réglage.
 */
async function updatePosition(sequelize, userId, { latitude, longitude, place_label: placeLabel }) {
  const settings = await getSettings(sequelize, userId);
  if (settings.sharing_mode === 'ghost') {
    return { stored: false, reason: 'ghost' };
  }

  const position = positionForMode(settings.sharing_mode, Number(latitude), Number(longitude));
  if (!position) return { stored: false, reason: 'invalid_position' };

  // INSERT ... ON CONFLICT, et pas un simple UPDATE.
  //
  // Depuis que le mode par défaut est « ville », la quasi-totalité des comptes
  // n'a AUCUNE ligne dans cette table — 3 502 sur 3 550 au moment du
  // changement. Un `UPDATE ... WHERE user_id` n'y touche alors rien du tout :
  // le mode par défaut aurait été « visible », et personne ne serait jamais
  // apparu. La ligne se crée donc à la première position reçue.
  //
  // `sharing_mode` est repris de `settings`, qui vient d'être relu en base :
  // on n'écrit jamais un mode fourni par l'appelant.
  await sequelize.query(
    `INSERT INTO nf_map_presence
       (user_id, sharing_mode, audience, latitude, longitude, place_label,
        shared_at, expires_at, created_at, updated_at)
     VALUES
       (:userId, :mode, :audience, :latitude, :longitude, :placeLabel,
        NOW(), NULL, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
        latitude = :latitude,
        longitude = :longitude,
        place_label = :placeLabel,
        shared_at = NOW(),
        expires_at = NULL,
        updated_at = NOW()`,
    {
      replacements: {
        userId,
        mode: settings.sharing_mode,
        audience: settings.audience,
        latitude: position.latitude,
        longitude: position.longitude,
        placeLabel: typeof placeLabel === 'string' ? placeLabel.slice(0, 120) : null,
      },
    }
  );

  return { stored: true, ...position, expires_in_hours: null };
}

/** Efface la position et repasse en fantôme. */
async function clearPresence(sequelize, userId) {
  await sequelize.query(
    `UPDATE nf_map_presence
        SET sharing_mode = 'ghost', latitude = NULL, longitude = NULL,
            place_label = NULL, expires_at = NULL, updated_at = NOW()
      WHERE user_id = :userId`,
    { replacements: { userId } }
  );
}

/**
 * Comptes visibles par l'appelant dans un rectangle.
 *
 * Le filtre d'audience est dans le SQL, pas appliqué après coup : une position
 * qu'on n'a pas le droit de voir ne doit jamais sortir de la base, y compris
 * dans un résultat intermédiaire qu'un log pourrait recopier.
 *
 * `mutuals` exige les deux sens de l'abonnement ; `followers` n'exige que
 * celui de l'observateur vers l'observé.
 */
async function nearby(sequelize, viewerId, bounds) {
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const west = Number(bounds.west);

  if (![north, south, east, west].every(Number.isFinite)) {
    throw new Error('Rectangle invalide');
  }
  if (north <= south) throw new Error('Rectangle invalide');

  // Rectangle borné : demander le monde entier reviendrait à télécharger la
  // position de tous ceux qui partagent, ce qui n'est pas une carte mais une
  // extraction.
  if (north - south > MAX_VIEWPORT_DEGREES || Math.abs(east - west) > MAX_VIEWPORT_DEGREES) {
    throw new Error('Zone trop large');
  }

  return sequelize.query(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.avatar,
            u.verified,
            u.premium,
            p.latitude,
            p.longitude,
            p.place_label,
            p.sharing_mode,
            p.shared_at
       FROM nf_map_presence p
       JOIN users u ON u.id = p.user_id
      -- La presence n'expire plus : la derniere position connue reste
      -- affichee jusqu'a ce qu'elle soit remplacee, ou effacee par un
      -- passage en mode fantome.
      --
      -- Retirer la condition d'expiration ne rend AUCUN compte masque
      -- visible : les deux lignes ci-dessous suffisent deja a exclure les
      -- fantomes, et clearPresence comme le passage en fantome mettent
      -- latitude a NULL.
      WHERE p.sharing_mode <> 'ghost'
        AND p.latitude IS NOT NULL
        AND u.is_active = TRUE
        AND p.user_id <> :viewerId
        AND p.latitude BETWEEN :south AND :north
        AND p.longitude BETWEEN LEAST(:west, :east) AND GREATEST(:west, :east)
        -- Un lien est OBLIGATOIRE, quel que soit le réglage : la carte ne
        -- montre jamais quelqu'un avec qui on n'a aucune relation.
        AND (
          EXISTS (
            SELECT 1 FROM user_follows f
             WHERE f.follower_id = :viewerId AND f.following_id = p.user_id AND f.status = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM user_follows f
             WHERE f.follower_id = p.user_id AND f.following_id = :viewerId AND f.status = 'active'
          )
        )
        -- Puis le réglage de la personne qui se montre restreint ce lien.
        AND (
          p.audience = 'connections'
          OR (
            p.audience = 'followers'
            AND EXISTS (
              SELECT 1 FROM user_follows f
               WHERE f.follower_id = :viewerId AND f.following_id = p.user_id AND f.status = 'active'
            )
          )
          OR (
            p.audience = 'mutuals'
            AND EXISTS (
              SELECT 1 FROM user_follows f
               WHERE f.follower_id = :viewerId AND f.following_id = p.user_id AND f.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM user_follows b
               WHERE b.follower_id = p.user_id AND b.following_id = :viewerId AND b.status = 'active'
            )
          )
        )
      ORDER BY p.shared_at DESC
      LIMIT ${MAX_RESULTS}`,
    { replacements: { viewerId, north, south, east, west }, type: QueryTypes.SELECT }
  );
}

/**
 * Tous les comptes liés à l'appelant, et leur état de partage.
 *
 * C'est la réponse honnête à « pourquoi ma carte est vide ». Un ami qui ne
 * partage pas apparaît ici — par son nom, jamais par sa position — avec de
 * quoi lui demander. Ce que cette liste ne fait PAS, et ne doit jamais faire :
 * aller chercher une position ailleurs (`user_location_events` par exemple)
 * pour combler le vide. Ces captures existent pour la détection de fraude et
 * les statistiques ; les afficher ici publierait la position de gens qui ne
 * l'ont jamais accepté, et souvent auprès de comptes qu'ils ne suivent même
 * pas en retour. Une carte vide est un problème d'adoption ; une carte pleine
 * de positions non consenties est un problème d'un tout autre ordre.
 */
async function connections(sequelize, viewerId) {
  return sequelize.query(
    `SELECT u.id,
            u.username,
            u.full_name,
            u.avatar,
            u.verified,
            u.premium,
            -- Plus d'echeance : une position connue reste valable jusqu'a
            -- son remplacement (voir nearby).
            (p.sharing_mode IS NOT NULL
             AND p.sharing_mode <> 'ghost'
             AND p.latitude IS NOT NULL)       AS is_sharing,
            EXISTS (
              SELECT 1 FROM user_follows f
               WHERE f.follower_id = :viewerId AND f.following_id = u.id AND f.status = 'active'
            )                                   AS i_follow,
            EXISTS (
              SELECT 1 FROM user_follows f
               WHERE f.follower_id = u.id AND f.following_id = :viewerId AND f.status = 'active'
            )                                   AS follows_me
       FROM users u
       LEFT JOIN nf_map_presence p ON p.user_id = u.id
      WHERE u.is_active = TRUE
        AND u.id <> :viewerId
        AND (
          EXISTS (
            SELECT 1 FROM user_follows f
             WHERE f.follower_id = :viewerId AND f.following_id = u.id AND f.status = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM user_follows f
             WHERE f.follower_id = u.id AND f.following_id = :viewerId AND f.status = 'active'
          )
        )
      ORDER BY is_sharing DESC, u.username ASC
      LIMIT 300`,
    { replacements: { viewerId }, type: QueryTypes.SELECT }
  );
}

/**
 * Demande à un ami d'activer sa position.
 *
 * Une invitation, pas un accès : elle ne révèle rien et ne donne rien. Le
 * destinataire reste libre de ne rien faire, et c'est le seul chemin par
 * lequel quelqu'un peut apparaître sur la carte de quelqu'un d'autre.
 *
 * Une invitation par personne et par jour : au-delà, « demander » devient
 * « harceler », et le bouton se retourne contre celui qu'il devait convaincre.
 */
async function invite(sequelize, Notification, fromUser, targetUserId) {
  const [link] = await sequelize.query(
    `SELECT 1 FROM user_follows
      WHERE status = 'active'
        AND ((follower_id = :viewerId AND following_id = :targetId)
          OR (follower_id = :targetId AND following_id = :viewerId))
      LIMIT 1`,
    { replacements: { viewerId: fromUser.id, targetId: targetUserId }, type: QueryTypes.SELECT }
  );
  if (!link) throw new Error('Aucun lien avec ce compte');

  const [recent] = await sequelize.query(
    `SELECT 1 FROM notifications
      WHERE user_id = :targetId
        AND type = 'system'
        AND content->>'kind' = 'nf_map_invite'
        AND content->>'from_user_id' = :viewerId
        AND created_at > NOW() - INTERVAL '1 day'
      LIMIT 1`,
    { replacements: { viewerId: String(fromUser.id), targetId: targetUserId }, type: QueryTypes.SELECT }
  );
  if (recent) return { sent: false, reason: 'already_invited_today' };

  await Notification.create({
    user_id: targetUserId,
    type: 'system',
    title: 'Carte NF',
    message: `@${fromUser.username} aimerait te voir sur la Carte NF.`,
    content: {
      kind: 'nf_map_invite',
      from_user_id: String(fromUser.id),
      from_username: fromUser.username,
      entity_type: 'nf_map',
    },
  });

  return { sent: true };
}

/**
 * Ancienne purge des positions expirées. Ne fait plus rien.
 *
 * La présence n'expire plus : la dernière position connue est conservée
 * jusqu'à son remplacement, ou son effacement volontaire par un passage en
 * mode fantôme. Une purge par échéance effacerait donc exactement ce qu'on
 * cherche à garder — y compris les positions reportées depuis l'historique de
 * localisation, dont l'échéance calculée est déjà passée.
 *
 * La fonction est conservée plutôt que supprimée : elle est appelée par le
 * worker (`server.js`), et la retirer demanderait de toucher au démarrage pour
 * un gain nul. Elle neutralise juste `expires_at` sur les lignes qui en
 * portent encore une, héritée de l'ancien fonctionnement.
 */
async function purgeExpired(sequelize) {
  const [, meta] = await sequelize.query(
    `UPDATE nf_map_presence
        SET expires_at = NULL, updated_at = NOW()
      WHERE expires_at IS NOT NULL`
  );
  return meta?.rowCount || 0;
}

module.exports = {
  SHARING_MODES,
  AUDIENCES,
  PRESENCE_TTL_HOURS,
  CITY_GRID_DEGREES,
  MAX_VIEWPORT_DEGREES,
  MAX_RESULTS,
  positionForMode,
  connections,
  invite,
  getSettings,
  updateSettings,
  updatePosition,
  clearPresence,
  nearby,
  purgeExpired,
};
