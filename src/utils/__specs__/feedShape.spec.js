'use strict';

/**
 * Une réponse affichée sans le tweet auquel elle répond est illisible : elle
 * commence au milieu d'une phrase qu'on n'a pas vue. Le bug est passé en
 * production parce que rien ne vérifiait l'invariant — la fonction fautive
 * plaçait les réponses à intervalle régulier, sans jamais regarder leur parent.
 *
 * D'où ces tests, tous formulés en termes d'invariant plutôt que d'algorithme :
 * ils resteront valables si le placement change de nouveau.
 */

const { spaceOutReplies } = require('../feedShape');

const tweet = (id) => ({ id });
const reply = (id, parentId) => ({ id, parent_tweet_id: parentId });
const ids = (list) => list.map((item) => item.id);

/** L'invariant central, vérifié sur n'importe quelle sortie. */
function everyReplyFollowsItsParent(feed) {
  return feed.every((item, index) => {
    if (!item.parent_tweet_id) return true;
    const previous = feed[index - 1];
    return Boolean(previous) && String(previous.id) === String(item.parent_tweet_id);
  });
}

describe('spaceOutReplies', () => {
  test('une réponse suit immédiatement son parent', () => {
    const feed = spaceOutReplies([tweet('a'), tweet('b'), reply('r', 'a')], 0);
    expect(everyReplyFollowsItsParent(feed)).toBe(true);
    expect(ids(feed)).toEqual(['a', 'r', 'b']);
  });

  test('une réponse dont le parent est absent de la page est écartée', () => {
    const feed = spaceOutReplies([tweet('a'), reply('orpheline', 'ailleurs')], 0);
    expect(ids(feed)).toEqual(['a']);
  });

  test('l’invariant tient sur un fil dense de réponses', () => {
    const input = [
      tweet('a'), tweet('b'), tweet('c'), tweet('d'), tweet('e'),
      reply('r1', 'a'), reply('r2', 'c'), reply('r3', 'e'),
      reply('perdue', 'inconnu'),
    ];
    const feed = spaceOutReplies(input, 0);
    expect(everyReplyFollowsItsParent(feed)).toBe(true);
    expect(ids(feed)).not.toContain('perdue');
  });

  test('l’ordre du scoring est préservé pour les tweets racines', () => {
    const feed = spaceOutReplies([tweet('a'), tweet('b'), tweet('c'), reply('r', 'b')], 0);
    expect(ids(feed).filter((id) => id !== 'r')).toEqual(['a', 'b', 'c']);
  });

  test('minGap espace les fils sans jamais casser l’adjacence', () => {
    // Avec un écart de 4, deux parents voisins ne peuvent pas porter tous les
    // deux leur réponse — mais celle qui est gardée reste collée à son parent.
    const input = [tweet('a'), tweet('b'), reply('ra', 'a'), reply('rb', 'b')];
    const feed = spaceOutReplies(input, 4);
    expect(everyReplyFollowsItsParent(feed)).toBe(true);
    expect(feed.filter((item) => item.parent_tweet_id)).toHaveLength(1);
  });

  test('un fil sans aucune réponse traverse sans modification', () => {
    const input = [tweet('a'), tweet('b'), tweet('c')];
    expect(ids(spaceOutReplies(input, 4))).toEqual(['a', 'b', 'c']);
  });

  test('une seule réponse par parent est diffusée', () => {
    // Au-delà, le fil de découverte se transforme en fil de conversation.
    const input = [tweet('a'), reply('r1', 'a'), reply('r2', 'a')];
    const feed = spaceOutReplies(input, 0);
    expect(everyReplyFollowsItsParent(feed)).toBe(true);
    expect(feed.filter((item) => item.parent_tweet_id)).toHaveLength(1);
  });

  test('les identifiants numériques et textuels se comparent correctement', () => {
    // La base renvoie des UUID, mais les tests et certains chemins passent des
    // nombres : une comparaison stricte laisserait fuir des orphelines.
    const feed = spaceOutReplies([{ id: 12 }, reply('r', 12)], 0);
    expect(ids(feed)).toEqual([12, 'r']);
  });

  test('une entrée vide ou absente ne fait pas tomber la route', () => {
    expect(spaceOutReplies([], 4)).toEqual([]);
    expect(spaceOutReplies(undefined, 4)).toEqual([]);
  });
});
