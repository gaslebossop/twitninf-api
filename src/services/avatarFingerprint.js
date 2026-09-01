const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const logger = require('../utils/logger');

/**
 * Empreinte PERCEPTUELLE d'une photo de profil.
 *
 * ── Pourquoi l'ancienne comparaison ne pouvait pas marcher ───────────────
 *
 * La veille usurpation comparait les avatars par leur URL
 * (`canonicalAvatar`). Or un upload produit un nom de fichier de la forme
 * `<uuid-de-l-uploadeur>-<timestamp>-<aleatoire>.jpg` : **l'identifiant du
 * compte est DANS l'URL**. Deux comptes differents qui televersent la meme
 * image obtiennent donc toujours deux URL differentes, et l'egalite d'URL ne
 * pouvait structurellement jamais se declencher entre deux comptes. Le signal
 * « meme photo » — le plus fort des trois — etait mort depuis le debut.
 *
 * ── Ce qu'on calcule, et pourquoi ce choix ───────────────────────────────
 *
 * Une **dHash** 64 bits : l'image est reduite en niveaux de gris a 9x8, puis
 * chaque pixel est compare a son voisin de droite. Le resultat ne decrit pas
 * les couleurs mais les VARIATIONS de luminosite — la structure de l'image.
 *
 * Consequence pratique, et c'est tout l'interet : redimensionner, recompresser
 * en JPEG, changer legerement la luminosite ou passer en PNG ne change presque
 * aucun bit. Un usurpateur qui reprend la photo de sa cible et la reposte,
 * meme retaillee par son telephone, garde la meme empreinte.
 *
 * On ajoute une **aHash** (moyenne) : elle se trompe differemment de la dHash,
 * et exiger que les deux concordent supprime l'essentiel des collisions.
 *
 * ── La signature couleur, et pourquoi elle ne DECIDE jamais ──────────────
 *
 * Une dHash est structurellement sensible au RECADRAGE : la grille se decale
 * et la moitie des bits changent. Mesure sur de vrais avatars : un recadrage
 * de 90 % donne une distance de 9 a 16, hors de portee du seuil.
 *
 * D'ou un troisieme signal, un histogramme couleur 4x4x4 : retirer 10 % des
 * pixels ne change pas la REPARTITION des couleurs. Mesure sur les memes
 * avatars, recadrage 90 % : 0,995 de similarite.
 *
 * Mais il SEPARE mal — deux avatars sans aucun rapport atteignent 0,943.
 * L'ecart utile entre « meme image recadree » et « images differentes » ne
 * fait que quelques centiemes. Il est donc cable comme un signal d'APPOINT :
 * il ne declenche jamais une alerte a lui seul, il ne fait que renforcer un
 * faisceau ou le pseudo et la bio disent deja quelque chose.
 *
 * ── Ce que ca ne fait pas ────────────────────────────────────────────────
 *
 * Ce n'est pas de la reconnaissance faciale. Deux photos DIFFERENTES de la
 * meme personne ne se ressemblent pas pour une dHash. C'est voulu : le but est
 * de reconnaitre une image REPRISE, ce qui est le mode operatoire courant, et
 * pas de decider qui est sur une photo — ce qui demanderait un modele
 * biometrique et poserait des questions d'un tout autre ordre.
 */

/** Taille de la grille dHash : 9 colonnes pour 8 comparaisons par ligne. */
const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;
/** aHash sur une grille carree. */
const AHASH_SIZE = 8;

/**
 * Distance de Hamming au-dela de laquelle deux images ne sont plus « la meme ».
 *
 * Sur 64 bits, la litterature situe le seuil de recompression/redimensionnement
 * autour de 10. On reste a 8 : la veille usurpation ACCUSE quelqu'un, et un
 * faux positif y coute plus cher qu'un faux negatif — la personne signalee
 * n'a rien demande.
 */
const MAX_HAMMING = 8;

/**
 * Seuil de la signature couleur — volontairement tres haut.
 *
 * A 0,985 on est au-dessus des 0,943 mesures entre avatars sans rapport, tout
 * en restant sous les 0,973 d'un recadrage a 75 %. La marge est mince : c'est
 * exactement pourquoi ce signal ne decide jamais seul.
 */
const MIN_COLOR_SIMILARITY = 0.985;

/** Ne jamais telecharger une image distante au-dela de cette taille. */
const MAX_REMOTE_BYTES = 5 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 4000;

/** Racine des avatars servis par `/static/avatars` (voir `server.js`). */
const AVATAR_DIR = path.join(__dirname, '..', 'public', 'avatars');

/**
 * Chemin local d'un avatar servi par nous, ou `null` s'il est externe.
 *
 * Lire le fichier sur disque plutot que de le retelecharger par HTTP evite un
 * aller-retour reseau par compte scanne — la veille balaie des milliers de
 * lignes — et surtout evite que le serveur se fasse des requetes a lui-meme.
 *
 * `path.basename` est applique au segment final AVANT de rejoindre : sans lui,
 * une URL contenant `..` sortirait du dossier des avatars.
 */
function localAvatarPath(avatarUrl) {
  const raw = String(avatarUrl || '').trim();
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  const marker = '/static/avatars/';
  const index = withoutQuery.indexOf(marker);
  if (index === -1) return null;
  const name = path.basename(withoutQuery.slice(index + marker.length));
  if (!name || name === '.' || name === '..') return null;
  return path.join(AVATAR_DIR, name);
}

/** Les 64 bits en hexadecimal, pour tenir dans une colonne texte indexable. */
function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

async function readImageBuffer(avatarUrl) {
  const local = localAvatarPath(avatarUrl);
  if (local) {
    return fs.readFile(local);
  }

  // Avatar externe (comptes importes, images par defaut hebergees ailleurs).
  const raw = String(avatarUrl || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(raw, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_REMOTE_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    // Le `content-length` peut mentir ou manquer : on revalide sur le reel.
    return buffer.byteLength > MAX_REMOTE_BYTES ? null : buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * dHash + aHash d'une image, ou `null` si elle est illisible.
 *
 * Ne jette jamais : une photo corrompue ne doit pas interrompre le balayage
 * de toute une table.
 */
async function fingerprintAvatar(avatarUrl) {
  try {
    const buffer = await readImageBuffer(avatarUrl);
    if (!buffer || !buffer.byteLength) return null;

    // `failOn: 'none'` : beaucoup d'images televersees par des telephones
    // portent des metadonnees invalides mais restent parfaitement lisibles.
    const image = sharp(buffer, { failOn: 'none' });

    const [dRaw, aRaw] = await Promise.all([
      image
        .clone()
        .greyscale()
        // `fit: 'fill'` et non `cover` : on veut la structure de l'image
        // ENTIERE. Un recadrage centre ferait diverger l'empreinte d'une image
        // et de la meme image dans un cadre different.
        .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
        .raw()
        .toBuffer(),
      image
        .clone()
        .greyscale()
        .resize(AHASH_SIZE, AHASH_SIZE, { fit: 'fill' })
        .raw()
        .toBuffer(),
    ]);

    const dBits = [];
    for (let row = 0; row < DHASH_HEIGHT; row += 1) {
      for (let col = 0; col < DHASH_WIDTH - 1; col += 1) {
        const left = dRaw[row * DHASH_WIDTH + col];
        const right = dRaw[row * DHASH_WIDTH + col + 1];
        dBits.push(left > right ? 1 : 0);
      }
    }

    let sum = 0;
    for (const value of aRaw) sum += value;
    const mean = sum / aRaw.length;
    const aBits = Array.from(aRaw, (value) => (value > mean ? 1 : 0));

    // Histogramme couleur 4x4x4, normalise. `removeAlpha` avant tout : un PNG
    // transparent ferait compter des pixels qui ne s'affichent pas.
    const { data, info } = await image
      .clone()
      .removeAlpha()
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bins = new Array(64).fill(0);
    for (let i = 0; i < data.length; i += info.channels) {
      bins[((data[i] >> 6) * 16) + ((data[i + 1] >> 6) * 4) + (data[i + 2] >> 6)] += 1;
    }
    const pixels = bins.reduce((total, value) => total + value, 0) || 1;

    return {
      dhash: bitsToHex(dBits),
      ahash: bitsToHex(aBits),
      // Arrondi a 5 decimales : la precision au-dela ne change aucun verdict
      // et triple la taille stockee.
      color: bins.map((value) => Math.round((value / pixels) * 1e5) / 1e5),
    };
  } catch (error) {
    logger.warn(`[avatar-fingerprint] illisible (${String(avatarUrl).slice(0, 80)}) : ${error.message}`);
    return null;
  }
}

/** Nombre de bits differents entre deux empreintes hexadecimales. */
function hammingDistance(hexA, hexB) {
  const a = String(hexA || '');
  const b = String(hexB || '');
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/**
 * Deux empreintes designent-elles la meme image ?
 *
 * Les DEUX hachages doivent concorder. Ils se trompent differemment — la dHash
 * sur les contrastes, la aHash sur la luminosite moyenne — donc exiger les deux
 * elimine l'essentiel des collisions, au prix de quelques recadrages agressifs
 * qu'on laissera passer. C'est le bon compromis pour une fonctionnalite qui
 * DESIGNE un compte.
 */
function sameImage(a, b) {
  if (!a?.dhash || !b?.dhash) return false;
  const dDistance = hammingDistance(a.dhash, b.dhash);
  if (dDistance > MAX_HAMMING) return false;
  if (a.ahash && b.ahash && hammingDistance(a.ahash, b.ahash) > MAX_HAMMING) return false;
  return true;
}

/**
 * Proximite visuelle sur 0–1, pour nuancer un score plutot que trancher.
 *
 * 0 des que la distance depasse le seuil : au-dela, deux images ne se
 * ressemblent pas « un peu », elles sont differentes. Une decroissance
 * continue jusqu'a 64 bits laisserait un residu de score a des images sans
 * aucun rapport.
 */
function imageSimilarity(a, b) {
  if (!a?.dhash || !b?.dhash) return 0;
  const distance = hammingDistance(a.dhash, b.dhash);
  if (distance > MAX_HAMMING) return 0;
  return 1 - distance / (MAX_HAMMING + 1);
}

/**
 * Similarite des signatures couleur, coefficient de Bhattacharyya (0–1).
 *
 * Somme des racines des produits : insensible a l'echelle, et il suffit qu'une
 * seule teinte dominante differe pour que le score chute — contrairement a une
 * distance euclidienne, qui pardonnerait un ecart reparti sur soixante cases.
 */
function colorSimilarity(a, b) {
  const x = a?.color;
  const y = b?.color;
  if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return 0;
  let total = 0;
  for (let i = 0; i < x.length; i += 1) total += Math.sqrt(x[i] * y[i]);
  return Math.min(1, total);
}

/**
 * Meme image APRES recadrage — signal d'appoint, jamais decisif.
 *
 * A n'utiliser que combine a un autre signal (pseudo proche, bio recopiee) :
 * seul, il designerait des comptes sans rapport, puisque deux avatars
 * quelconques atteignent 0,943.
 */
function likelyCroppedCopy(a, b) {
  return colorSimilarity(a, b) >= MIN_COLOR_SIMILARITY && !sameImage(a, b);
}

module.exports = {
  fingerprintAvatar,
  colorSimilarity,
  likelyCroppedCopy,
  MIN_COLOR_SIMILARITY,
  hammingDistance,
  sameImage,
  imageSimilarity,
  localAvatarPath,
  bitsToHex,
  MAX_HAMMING,
};
