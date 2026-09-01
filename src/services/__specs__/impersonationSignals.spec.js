const {
  handleAnalysis,
  keyboardSimilarity,
  stripDecoration,
  permutationSimilarity,
  phoneticKey,
  weightedOverlap,
  longestSharedRun,
  contextMultiplier,
  audienceOverlap,
  contentWords,
} = require('../impersonationSignals');

/*
 * Chaque bloc protege UNE deformation que la distance d'edition seule ne voit
 * pas. Ce sont les schemas reellement employes : ils viennent des comptes
 * usurpant @policiercongo, pas d'un catalogue theorique.
 */

describe('faute de frappe plausible (AZERTY)', () => {
  test('une substitution entre touches VOISINES coute moins cher', () => {
    // `o` et `p` sont cote a cote : la main a glisse. `o` et `x` ne le sont
    // pas : ce n'est pas le meme mot. Une distance d'edition les confond, et
    // il faut alors soit accepter les deux (bruit), soit refuser les deux
    // (angle mort).
    const voisine = keyboardSimilarity('policiercongo', 'policiercpngo');
    const lointaine = keyboardSimilarity('policiercongo', 'policiercxngo');
    expect(voisine).toBeGreaterThan(lointaine);
    expect(handleAnalysis('policiercongo', 'policiercpngo').kind).toBe('keyboard');
  });

  test('le clavier retenu est le FRANCAIS', () => {
    // `a` et `q` sont voisins en AZERTY, pas en QWERTY. Se tromper de clavier
    // ferait manquer le typosquatting du public reel de la plateforme.
    expect(keyboardSimilarity('azerty', 'qzerty')).toBeGreaterThan(
      keyboardSimilarity('azerty', 'pzerty'),
    );
  });
});

describe('remplissage autour d\'un pseudo pris', () => {
  test('les chiffres de queue ne font pas un autre nom', () => {
    expect(stripDecoration('policiercongo2')).toBe('policiercongo');
    expect(stripDecoration('policiercongo_01')).toBe('policiercongo');
  });

  test('les ornements de bord non plus', () => {
    expect(stripDecoration('xX_policiercongo_Xx')).toBe('policiercongo');
  });

  test('un pseudo decore est reconnu comme une reprise', () => {
    const r = handleAnalysis('policiercongo', 'policiercongo2');
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.kind).toBe('decorated');
  });
});

describe('blocs permutes', () => {
  test('congopolicier est reconnu face a policiercongo', () => {
    // Aucune distance d'edition ne voit une permutation : elle mesure des
    // insertions et des substitutions, pas des deplacements de blocs.
    expect(permutationSimilarity('policiercongo', 'congopolicier')).toBeGreaterThan(0.7);
  });

  test('deux mots sans rapport ne permutent pas', () => {
    expect(permutationSimilarity('policiercongo', 'boulangerie75')).toBeLessThan(0.2);
  });
});

describe('homophonie', () => {
  test('des pseudos qui se PRONONCENT pareil sont rapproches', () => {
    // Un pseudo se transmet a l'oral : deux formes homophones sont
    // interchangeables pour qui le cherche de memoire.
    expect(phoneticKey('polissierkongo')).toBe(phoneticKey('policiercongo'));
    expect(handleAnalysis('policiercongo', 'polissierkongo').score).toBeGreaterThanOrEqual(0.9);
  });

  test('la reduction phonetique ne colle pas deux mots differents', () => {
    expect(phoneticKey('boulangerie')).not.toBe(phoneticKey('policiercongo'));
  });
});

describe('garde-fous du pseudo', () => {
  test('sous 4 caracteres, rien ne se prouve', () => {
    expect(handleAnalysis('leo', 'lea').score).toBe(0);
  });

  test('deux pseudos sans rapport restent bas', () => {
    expect(handleAnalysis('policiercongo', 'boulangerie75').score).toBeLessThan(0.5);
  });
});

describe('texte : la rarete decide', () => {
  // Assez de mots PORTEURS (les mots vides sont ecartes) pour que « la plus
  // longue suite commune » ait de la matiere a mesurer.
  const bio = 'La moderation quotidienne reste une astreinte technique difficile, jamais une personnalite publique.';

  test('les mots vides ne comptent pas', () => {
    // Deux bios francaises partagent forcement « de », « la », « pour ». Les
    // compter dilue le signal jusqu'a l'inutilite.
    expect(contentWords('de la pour et le les')).toHaveLength(0);
  });

  test('une reprise partielle ressort, un texte sans rapport non', () => {
    expect(weightedOverlap(bio, 'la moderation quotidienne reste une astreinte technique difficile'))
      .toBeGreaterThan(0.7);
    expect(weightedOverlap(bio, 'je partage mes recettes de cuisine du dimanche'))
      .toBeLessThan(0.15);
  });

  test('un mot RARE partage pese plus qu\'un mot courant', () => {
    // Corpus : « toujours » vu partout, « astreinte » vu une fois.
    const freq = new Map([['toujours', 900], ['astreinte', 1], ['bonjour', 800]]);
    const rare = weightedOverlap('astreinte bonjour toujours', 'astreinte cuisine velo', freq, 1000);
    const courant = weightedOverlap('astreinte bonjour toujours', 'toujours cuisine velo', freq, 1000);
    expect(rare).toBeGreaterThan(courant);
  });

  test('une longue suite identique ne se dilue pas dans un texte long', () => {
    // Personne n'ecrit par hasard six mots consecutifs identiques — et ce
    // signal, contrairement a un recouvrement d'ensembles, ne s'affaiblit pas
    // quand les textes s'allongent.
    const long = `${bio} ${'remplissage divers et varie '.repeat(20)}`;
    expect(longestSharedRun(long, bio)).toBeGreaterThanOrEqual(6);
    expect(longestSharedRun(long, 'cuisine velo montagne photo')).toBe(0);
  });
});

describe('contexte : qui etait la avant', () => {
  test('un compte ANTERIEUR a la cible ne l\'usurpe pas', () => {
    // Le garde-fou le plus important du fichier : sans lui, on signale le
    // compte historique a l'arrivant.
    const { factor, reasons } = contextMultiplier(
      { created_at: '2026-06-01' },
      { created_at: '2026-01-01' },
    );
    expect(factor).toBeLessThan(0.5);
    expect(reasons).toContain('suspect_is_older');
  });

  test('une coquille vide qui adopte une identite est plus suspecte', () => {
    const { factor, reasons } = contextMultiplier(
      { created_at: '2026-01-01' },
      { created_at: '2026-08-30', _tweetCount: 0, _followerCount: 1 },
    );
    expect(factor).toBeGreaterThan(1);
    expect(reasons).toContain('empty_shell');
  });

  test('un compte etabli l\'est moins', () => {
    const { factor, reasons } = contextMultiplier(
      { created_at: '2026-01-01' },
      { created_at: '2026-08-30', _tweetCount: 120, _followerCount: 60 },
    );
    expect(factor).toBeLessThan(1);
    expect(reasons).toContain('established_account');
  });

  test('sans date, le contexte reste neutre', () => {
    expect(contextMultiplier({}, {}).factor).toBe(1);
  });
});

describe('audience', () => {
  const cible = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

  test('demarcher les abonnes de la cible se voit', () => {
    // Changer de pseudo prend une seconde ; se refaire une audience prend des
    // semaines. C'est la trace la plus couteuse a effacer.
    expect(audienceOverlap(cible, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x', 'y']))
      .toBeGreaterThan(0.7);
  });

  test('une audience propre ne declenche rien', () => {
    expect(audienceOverlap(cible, ['z1', 'z2', 'z3', 'z4', 'z5', 'z6']))
      .toBe(0);
  });

  test('sous cinq abonnes, on ne se prononce pas', () => {
    // Deux comptes d'une petite plateforme partagent forcement leurs rares
    // abonnes : ce serait du hasard promu en preuve.
    expect(audienceOverlap(cible, ['a', 'b'])).toBe(0);
    expect(audienceOverlap(new Set(['a', 'b']), ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(0);
  });
});
