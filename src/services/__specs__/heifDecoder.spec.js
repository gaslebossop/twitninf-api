const sharp = require('sharp');

const { looksLikeHeif, toDecodableBuffer } = require('../heifDecoder');

/**
 * Régression : une photo prise sur iPhone (HEIC, codec HEVC) faisait échouer
 * TOUT envoi d'image — story comme tweet — avec le message trompeur
 * « source: bad seek to <offset> », qui laisse croire à un fichier tronqué
 * alors que le fichier est intact et que c'est le codec qui n'est pas lisible
 * par le libvips embarqué dans `sharp`.
 *
 * La conversion elle-même dépend du binaire `heif-convert`, absent des postes
 * de développement Windows : elle est donc vérifiée sur la machine cible, pas
 * ici. Ce qui est verrouillé ici, c'est la DÉCISION de convertir — la
 * reconnaissance du format sur les octets — et la garantie que rien d'autre ne
 * change de comportement au passage.
 */

/** En-tête ISO-BMFF minimal : taille de boîte, `ftyp`, puis la marque. */
function heifHeader(brand) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(32, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write(brand, 8, 'ascii');
  return buffer;
}

describe('looksLikeHeif', () => {
  it('reconnaît les marques HEIF, y compris les génériques', () => {
    // `mif1` est la marque que posent certains appareils au lieu de `heic` :
    // l'oublier laissait passer une partie des photos sans conversion.
    for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) {
      expect(looksLikeHeif(heifHeader(brand))).toBe(true);
    }
  });

  it('ignore la casse de la marque', () => {
    expect(looksLikeHeif(heifHeader('HEIC'))).toBe(true);
  });

  it('ne confond pas un MP4 avec une image HEIF', () => {
    // Même famille de conteneur (ISO-BMFF), mais ce n'est pas une image :
    // le convertir n'aurait aucun sens.
    expect(looksLikeHeif(heifHeader('isom'))).toBe(false);
    expect(looksLikeHeif(heifHeader('mp42'))).toBe(false);
  });

  it('rejette ce qui n’est pas un conteneur ISO-BMFF', () => {
    expect(looksLikeHeif(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(looksLikeHeif(Buffer.from('pas une image du tout'))).toBe(false);
  });

  it('ne casse pas sur une entrée absente ou trop courte', () => {
    expect(looksLikeHeif(null)).toBe(false);
    expect(looksLikeHeif(undefined)).toBe(false);
    expect(looksLikeHeif(Buffer.alloc(0))).toBe(false);
    expect(looksLikeHeif(Buffer.from('ftyp'))).toBe(false);
    expect(looksLikeHeif('une chaîne, pas un Buffer')).toBe(false);
  });
});

describe('toDecodableBuffer', () => {
  it('rend le tampon d’origine quand sharp sait déjà le lire', async () => {
    // Le cas courant — un JPEG ou un PNG ne doit payer aucune conversion.
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();

    const result = await toDecodableBuffer(jpeg);

    expect(result).toBe(jpeg);
  });

  it('relance l’erreur de sharp sur un fichier illisible qui n’est pas du HEIF', async () => {
    // Un fichier corrompu doit continuer à échouer : la reprise ne sert qu'au
    // HEIF, elle ne doit pas devenir un filet qui masque les vraies erreurs.
    await expect(toDecodableBuffer(Buffer.from('ceci n’est pas une image')))
      .rejects.toThrow();
  });
});
