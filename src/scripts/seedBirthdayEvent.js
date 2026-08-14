/**
 * Injecte l'événement « Anniversaire twitninf » (24-31 août 2026).
 *
 *     node src/scripts/seedBirthdayEvent.js            # injecte, inactif
 *     node src/scripts/seedBirthdayEvent.js --activate # injecte et allume
 *
 * Rejouable : réinjecter met à jour l'événement existant sans toucher aux
 * réclamations déjà faites (elles vivent dans `tw_quest_claims`, référencées
 * par slug).
 *
 * ── `is_active: false` par défaut, et c'est délibéré ──────────────────────
 * Injecter un événement déjà allumé, c'est le lancer à l'instant de
 * l'injection — soit dix jours trop tôt. On l'allume le 24, à la main ou par
 * tâche planifiée.
 *
 * ── Le champ `measure` ────────────────────────────────────────────────────
 * Il n'existe QUE côté serveur : c'est lui qui dit au moteur comment compter,
 * et le contrôleur le retire avant d'envoyer les quêtes au mobile. Publier
 * « il suffit de likes de comptes distincts dans cette fenêtre » reviendrait à
 * donner la recette du contournement.
 */

const { sequelize, TwEvent } = require('../models');

const START = '2026-08-24T00:00:00+02:00';
const END = '2026-08-31T23:59:59+02:00';
const HASHTAG = 'JoyeuxTwitninf';

/**
 * Tables de tirage.
 *
 * Les poids ne sont pas égaux : un paquet où tout est équiprobable n'a aucune
 * saveur. Le lot le plus gros doit rester rare pour que les autres comptent.
 */
const TOUR_POOL = [
  { weight: 45, kind: 'coins', label: '300 NF', payload: { amount: 300 } },
  { weight: 30, kind: 'cosmetic', label: 'Effet de profil « Étincelles »', payload: { slot: 'profile_effect', value: 'sparkles' } },
  { weight: 18, kind: 'cosmetic', label: 'Police de nom « Techno »', payload: { slot: 'name_font', value: 'techno' } },
  { weight: 7, kind: 'pro_days', label: '3 jours de Pro', payload: { days: 3 } },
];

const GIFT_POOL = [
  { weight: 40, kind: 'coins', label: '700 NF', payload: { amount: 700 } },
  { weight: 28, kind: 'cosmetic', label: 'Cadre d\'avatar « Couronne »', payload: { slot: 'avatar_decoration', value: 'crown' } },
  { weight: 22, kind: 'title', label: 'Titre « Généreux »', payload: { title: 'Généreux' } },
  { weight: 10, kind: 'pro_days', label: '7 jours de Pro', payload: { days: 7 } },
];

const QUESTS = [
  {
    id: 'candle',
    kind: 'single',
    tier: 'bronze',
    title: 'Allume ta bougie',
    description: `Publie un tweet avec #${HASHTAG}. C'est la porte d'entrée : tout le reste s'ouvre derrière.`,
    icon: 'flame-outline',
    goal: 1,
    measure: { source: 'tweets', hashtag: HASHTAG },
    reward: { kind: 'coins', label: '120 NF', payload: { amount: 120 } },
  },
  {
    id: 'toast',
    kind: 'social',
    tier: 'bronze',
    title: 'Trinque',
    description: 'Fais aimer ta bougie par 5 comptes différents. Un même compte ne compte qu\'une fois.',
    icon: 'wine-outline',
    goal: 5,
    requires: ['candle'],
    // Distinct par liker, et l'auteur est exclu : sans cela, un seul complice
    // qui aime et retire son like en boucle suffirait.
    measure: { source: 'likes_received_distinct', hashtag: HASHTAG },
    reward: {
      kind: 'cosmetic',
      label: 'Décoration d\'avatar « Pétales »',
      payload: { slot: 'avatar_decoration', value: 'petals' },
    },
  },
  {
    id: 'spread',
    kind: 'count',
    tier: 'bronze',
    title: 'Distributeur de bonne humeur',
    description: 'Aime 50 tweets pendant la semaine. Celle-là se remplit toute seule.',
    icon: 'heart-outline',
    goal: 50,
    measure: { source: 'likes_given' },
    reward: { kind: 'multiplier', label: 'Gains × 2 pendant 24 h', payload: { factor: 2, hours: 24 } },
  },
  {
    id: 'tour',
    kind: 'explore',
    tier: 'silver',
    title: 'Le grand tour',
    description:
      'Passe voir les six recoins de l\'app : la Carte NF, le Casino, le Studio créateur, le Trading, les Lives et le Marché des pseudos.',
    icon: 'compass-outline',
    goal: 6,
    // Seule source possible : l'API ne voit pas passer une navigation.
    measure: { source: 'signals' },
    reward: {
      kind: 'lootbox',
      label: 'Paquet surprise',
      teaser: ['300 NF', '3 jours de Pro', 'Un effet de profil', 'Une police de nom'],
      pool: TOUR_POOL,
    },
  },
  {
    id: 'gift',
    kind: 'social',
    tier: 'silver',
    title: 'On n\'offre pas qu\'à soi',
    description: 'Envoie des NF à 3 comptes différents. Le montant n\'a aucune importance.',
    icon: 'gift-outline',
    goal: 3,
    measure: { source: 'transfers_distinct' },
    reward: {
      kind: 'lootbox',
      label: 'Paquet surprise (rare)',
      teaser: ['700 NF', '7 jours de Pro', 'Un cadre d\'avatar exclusif', 'Un titre de profil'],
      pool: GIFT_POOL,
    },
  },
  {
    id: 'guestbook',
    kind: 'single',
    tier: 'silver',
    title: 'Le livre d\'or',
    description: 'Laisse un mot d\'anniversaire sur la page de l\'événement. Il sera lisible par tout le monde.',
    icon: 'create-outline',
    goal: 1,
    measure: { source: 'signals' },
    reward: { kind: 'title', label: 'Titre « Invité d\'honneur »', payload: { title: 'Invité d\'honneur' } },
  },
  {
    id: 'midnight',
    kind: 'timed',
    tier: 'gold',
    title: 'À minuit pile',
    description:
      'Publie quelque chose dans les vingt minutes qui suivent minuit, la nuit du 24. Vingt minutes, une fois. Après, c\'est fini.',
    icon: 'moon-outline',
    goal: 1,
    // La fenêtre est en +02:00 et resserre celle de l'événement. Le moteur
    // compare en UTC après conversion — pas en heure locale du serveur.
    window: { from: '2026-08-24T00:00:00+02:00', to: '2026-08-24T00:20:00+02:00' },
    measure: { source: 'tweets' },
    reward: {
      kind: 'cosmetic',
      label: 'Police de nom « Minuit », exclusive',
      payload: { slot: 'name_font', value: 'roman', exclusive: true },
    },
  },
  {
    id: 'sevennights',
    kind: 'streak',
    tier: 'gold',
    title: 'Sept nuits',
    description: 'Reviens chaque jour de l\'événement. Sauter un jour remet le compteur à zéro — c\'est le principe.',
    icon: 'flame',
    goal: 7,
    // Un tweet OU un like suffit à marquer la journée : exiger de publier
    // rendrait la série inatteignable pour qui lit sans écrire.
    measure: { source: 'active_days', timezone: 'Europe/Paris' },
    reward: { kind: 'pro_days', label: '7 jours de Pro', payload: { days: 7 } },
  },
  {
    id: 'cake',
    kind: 'collective',
    tier: 'silver',
    title: 'Le gâteau géant',
    description:
      'Un objectif commun à TOUTE l\'app : 10 000 tweets publiés pendant la semaine. Si le compte y est, tout le monde touche la récompense, y compris ceux qui n\'ont rien posté.',
    icon: 'people-outline',
    goal: 10000,
    measure: { source: 'global_tweets' },
    reward: { kind: 'coins', label: '300 NF pour tout le monde', payload: { amount: 300 } },
  },
  {
    id: 'echo',
    kind: 'secret',
    tier: 'legendary',
    hidden: true,
    title: 'L\'écho',
    description: 'Tu as trouvé quelque chose que personne ne t\'avait dit de chercher.',
    icon: 'sparkles',
    goal: 1,
    // Déclencheur à câbler côté app (voir docs/EVENTS_API.md) : le client
    // signale, le serveur enregistre. Tant que rien ne le déclenche, la quête
    // reste invisible — `hidden` la masque tant que la progression est nulle.
    measure: { source: 'signals' },
    reward: { kind: 'badge', label: 'Badge « Chat noir »', payload: { badge: 'black_cat', permanent: true } },
  },
  {
    id: 'founder',
    kind: 'count',
    tier: 'legendary',
    title: 'Fondateur',
    description: 'Termine huit des autres quêtes. Ce badge ne sera plus jamais distribué après le 31 août.',
    icon: 'ribbon-outline',
    goal: 8,
    // Se compte sur les AUTRES quêtes : le moteur s'exclut lui-même du total,
    // sinon le sommet serait atteint une quête trop tôt.
    measure: { source: 'quests_completed' },
    reward: {
      kind: 'badge',
      label: 'Badge « Fondateur » + 1 000 NF + 30 jours de Pro',
      payload: {
        badge: 'founder',
        permanent: true,
        coins: 1000,
        pro_days: 30,
        title: 'Là depuis la première bougie',
      },
    },
  },
];

const EVENT = {
  slug: 'birthday2026',
  name: 'Anniversaire twitninf',
  description:
    'Une semaine pour fêter twitninf : onze quêtes, des récompenses qu\'on ne reverra pas, et un badge qui disparaît le 31 août.',
  starts_at: new Date(START),
  ends_at: new Date(END),
  priority: 100,
  art: 'birthday',
  features: {
    hub: true,
    banner: true,
    intro: true,
    // La DA reste sur la page d'événement et le bandeau. Repeindre le fil
    // entier en doré pendant huit jours, c'est imposer une fête à qui ne l'a
    // pas demandée.
    skinApp: false,
    earnMultiplier: 1.5,
    dailyGift: true,
  },
  quests: QUESTS,
  banner_message: 'twitninf fête son anniversaire — 11 quêtes, une semaine.',
};

async function main() {
  const activate = process.argv.includes('--activate');

  await sequelize.authenticate();

  const [event, created] = await TwEvent.findOrCreate({
    where: { slug: EVENT.slug },
    defaults: { ...EVENT, is_active: activate },
  });

  if (!created) {
    // On ne touche PAS à `is_active` sur une mise à jour, sauf demande
    // explicite : réinjecter pour corriger une faute de frappe ne doit pas
    // éteindre un événement en cours.
    await event.update({ ...EVENT, ...(activate ? { is_active: true } : {}) });
  }

  console.log(`OK: evenement ${EVENT.slug} ${created ? 'cree' : 'mis a jour'}`);
  console.log(`    ${QUESTS.length} quetes | DA: ${EVENT.art} | actif: ${event.is_active}`);
  console.log(`    du ${START} au ${END}`);
  if (!event.is_active) {
    console.log('    -> pour l allumer le 24 : node src/scripts/seedBirthdayEvent.js --activate');
  }

  await sequelize.close();
}

// Exporté pour être vérifiable sans base : les définitions se relisent et se
// testent, l'injection ne part que si le fichier est lancé directement.
module.exports = { EVENT, QUESTS, TOUR_POOL, GIFT_POOL };

if (require.main === module) {
  main().catch((error) => {
    console.error('ECHEC du seed:', error.message);
    process.exit(1);
  });
}
