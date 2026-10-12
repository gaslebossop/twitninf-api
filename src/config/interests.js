/**
 * Catalogue des centres d'intérêt proposés à l'inscription.
 *
 * Les identifiants sont stables : ce sont eux qui sont enregistrés dans
 * `user_preferences.content_preferences.preferred_topics`. Changer un libellé
 * est sans risque, changer un `id` orphelinerait les choix déjà faits.
 *
 * `keywords` n'est pas encore lu par l'algorithme du fil : les intérêts sont
 * seulement stockés pour l'instant. Ils sont là pour le jour où « Pour toi »
 * s'en servira, afin que l'appariement ne soit pas réinventé à ce moment-là.
 */
const INTERESTS = [
  { id: 'tech', label: 'Tech', keywords: ['tech', 'dev', 'code', 'ia', 'ai', 'iphone', 'android'] },
  { id: 'gaming', label: 'Jeux vidéo', keywords: ['gaming', 'jeu', 'jeux', 'fortnite', 'minecraft', 'gta', 'ps5', 'switch'] },
  { id: 'music', label: 'Musique', keywords: ['musique', 'son', 'rap', 'album', 'concert', 'spotify'] },
  { id: 'sport', label: 'Sport', keywords: ['sport', 'basket', 'nba', 'tennis', 'f1', 'muscu'] },
  { id: 'football', label: 'Foot', keywords: ['foot', 'football', 'ligue1', 'psg', 'om', 'ldc'] },
  { id: 'fashion', label: 'Mode', keywords: ['mode', 'fashion', 'outfit', 'sneakers', 'drip'] },
  { id: 'movies', label: 'Cinéma & séries', keywords: ['film', 'cinema', 'série', 'serie', 'netflix'] },
  { id: 'anime', label: 'Mangas & animés', keywords: ['manga', 'anime', 'animé', 'onepiece', 'naruto'] },
  { id: 'humor', label: 'Humour', keywords: ['humour', 'mdr', 'ptdr', 'meme', 'drole'] },
  { id: 'news', label: 'Actu', keywords: ['actu', 'news', 'info', 'politique'] },
  { id: 'finance', label: 'Crypto & finance', keywords: ['crypto', 'bitcoin', 'bourse', 'finance', 'trading'] },
  { id: 'art', label: 'Art & design', keywords: ['art', 'design', 'dessin', 'illustration', 'photo'] },
  { id: 'travel', label: 'Voyage', keywords: ['voyage', 'travel', 'vacances'] },
  { id: 'food', label: 'Cuisine', keywords: ['cuisine', 'recette', 'food', 'resto'] },
  { id: 'science', label: 'Sciences', keywords: ['science', 'espace', 'nasa', 'physique'] },
  { id: 'school', label: 'École', keywords: ['école', 'ecole', 'cours', 'bac', 'brevet', 'lycée', 'college'] },
];

const INTEREST_IDS = new Set(INTERESTS.map((i) => i.id));

/** Nombre de choix demandés à l'inscription (l'utilisateur peut aussi passer). */
const MIN_INTERESTS = 3;
const MAX_INTERESTS = INTERESTS.length;

module.exports = { INTERESTS, INTEREST_IDS, MIN_INTERESTS, MAX_INTERESTS };
