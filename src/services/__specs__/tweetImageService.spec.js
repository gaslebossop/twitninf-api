'use strict';

/**
 * `media_urls` arrive du client. Le filtre est donc la seule chose qui empêche
 * un tweet de faire charger une ressource choisie par son auteur à tous ceux
 * qui le croisent — ce qui reviendrait à leur faire livrer leur IP et l'heure
 * de lecture à un tiers.
 */

const { sanitizeMediaUrls, MAX_IMAGES_PER_TWEET } = require('../tweetImageService');
const { getPublicMediaOrigin } = require('../../utils/publicMediaOrigin');

const ORIGIN = getPublicMediaOrigin();
const ours = (name) => `${ORIGIN}/static/tweets/${name}`;

describe('tweetImageService — filtrage des médias', () => {
  test('garde les images émises par cette API', () => {
    const urls = [ours('tweet-1-2-abc.jpg'), ours('tweet-1-3-def.jpg')];
    expect(sanitizeMediaUrls(urls)).toEqual(urls);
  });

  test('rejette un serveur tiers, même déguisé en préfixe', () => {
    expect(
      sanitizeMediaUrls([
        'https://exemple-pirate.test/static/tweets/a.jpg',
        `https://exemple-pirate.test/?${ORIGIN}/static/tweets/a.jpg`,
        `${ORIGIN}.exemple-pirate.test/static/tweets/a.jpg`,
        'http://127.0.0.1:3001/static/tweets/a.jpg',
      ])
    ).toEqual([]);
  });

  test('rejette les autres dossiers du même domaine', () => {
    // Sinon on republierait l'avatar d'un tiers comme sa propre image.
    expect(sanitizeMediaUrls([`${ORIGIN}/static/avatars/quelquun.jpg`])).toEqual([]);
    expect(sanitizeMediaUrls([`${ORIGIN}/static/stories/quelquun.jpg`])).toEqual([]);
  });

  test('rejette une remontée de dossier', () => {
    expect(sanitizeMediaUrls([ours('../avatars/quelquun.jpg')])).toEqual([]);
    expect(sanitizeMediaUrls([ours('sous/dossier.jpg')])).toEqual([]);
  });

  test('respecte le plafond du modèle', () => {
    const trop = Array.from({ length: 9 }, (_, i) => ours(`img-${i}.jpg`));
    expect(sanitizeMediaUrls(trop)).toHaveLength(MAX_IMAGES_PER_TWEET);
  });

  test('ne casse pas sur une entrée absente ou malformée', () => {
    expect(sanitizeMediaUrls(undefined)).toEqual([]);
    expect(sanitizeMediaUrls(null)).toEqual([]);
    expect(sanitizeMediaUrls('pas un tableau')).toEqual([]);
    expect(sanitizeMediaUrls([null, 42, {}, ''])).toEqual([]);
  });
});
