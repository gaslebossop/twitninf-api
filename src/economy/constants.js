/**
 * Monnaie virtuelle fermée (type Robux) : achats EUR → mint TWC,
 * dépenses → trésorerie plateforme, récompenses créateurs ← trésorerie uniquement.
 */

const TREASURY_USER_ID =
  process.env.TWITNINF_TREASURY_USER_ID || '01837802-c2ae-4de0-9471-7a9b642afde2';

/** Prix de référence affiché (1 NF = 10 €) — ne fluctue pas au quotidien */
const REFERENCE_PRICE_EUR = 10;

const SYMBOL = 'TWC';

/** Packages : prix EUR fixes, bonus intégré au volume (meilleur rapport sur gros packs) */
const PURCHASE_PACKAGES = [
  { id: 'small', name: 'Pack Starter', priceEur: 0.99, baseCoins: 100, bonusPercent: 0, popular: false },
  { id: 'medium', name: 'Pack Popular', priceEur: 4.99, baseCoins: 500, bonusPercent: 5, popular: true },
  { id: 'large', name: 'Pack Premium', priceEur: 9.99, baseCoins: 1050, bonusPercent: 10, popular: false },
  { id: 'mega', name: 'Pack Elite', priceEur: 19.99, baseCoins: 2200, bonusPercent: 12, popular: false },
  { id: 'ultimate', name: 'Pack Ultimate', priceEur: 49.99, baseCoins: 5750, bonusPercent: 15, popular: false },
  { id: 'vip_100', name: 'Pack VIP 100€', priceEur: 100, baseCoins: 12000, bonusPercent: 18, popular: false },
  { id: 'vip_500', name: 'Pack VIP 500€', priceEur: 500, baseCoins: 62000, bonusPercent: 20, popular: false },
  { id: 'vip_1000', name: 'Pack VIP 1000€', priceEur: 1000, baseCoins: 128000, bonusPercent: 22, popular: false },
  { id: 'vip_10000', name: 'Pack VIP 10000€', priceEur: 10000, baseCoins: 1300000, bonusPercent: 25, popular: false }
];

const MIN_TRANSFER_TWC = 0.01;
const MIN_SPEND_TWC = 0.01;
const MIN_REWARD_TWC = 0.01;

/** Frais sur transfert P2P (fraction vers la trésorerie) */
const P2P_TRANSFER_FEE_RATE = 0.20;

/**
 * Frais réduits pour les abonnés actifs (Plus et Pro).
 *
 * Contrairement aux avantages cosmétiques de l'abonnement, celui-ci se
 * re-consomme : il est ressenti à chaque virement, pas une seule fois à la
 * souscription. C'est ce qui en fait un argument de RENOUVELLEMENT — l'offre
 * étant sans reconduction automatique, un avantage livré une fois pour toutes
 * ne pèse rien au bout de 30 jours.
 *
 * Le palier retenu est celui de l'EXPÉDITEUR : c'est lui qui paie la
 * commission, le destinataire n'a rien à voir dans l'affaire.
 */
const P2P_TRANSFER_FEE_RATE_SUBSCRIBER = 0.10;

/**
 * Virements sans commission — palier Ultra.
 *
 * Zéro, et pas « très bas » : un taux résiduel n'aurait pas d'argument
 * (« presque gratuit » ne se vend pas), et il obligerait quand même à écrire
 * la ligne de frais au grand livre pour un montant dérisoire.
 *
 * L'abus tient tout seul par l'arithmétique : Ultra coûte 300 NF pour
 * `DEFAULT_DURATION_DAYS`, donc la gratuité ne devient rentable qu'au-delà de
 * 3 000 NF virés sur la période (300 / 0,10, le taux abonné qu'on remplace).
 * Personne n'achète le palier le plus cher pour déplacer moins que ça, et
 * au-dessus le compte est de toute façon dans le champ de l'anti-fraude, que
 * cet avantage ne désarme PAS : la gratuité porte sur la commission, jamais
 * sur l'autorisation du virement (voir `transactionAuthorizationService`).
 */
const P2P_TRANSFER_FEE_RATE_ULTRA = 0;

/**
 * Minage (app Windows) : preuve de travail partagée entre tous les mineurs
 * (premier arrivé, premier servi), seule source de création monétaire non
 * adossée à un achat réel. Récompense = base × 4^(difficulté − 4).
 * Dilue le cours proportionnellement à la récompense minée (contrairement
 * aux achats, neutres pour le prix, backés en EUR).
 */
const MINING_BASE_REWARD_TWC = 0.1; // récompense à la difficulté minimale (4) — divisée par 5 (CPU minait trop)
const MINING_DAILY_WIN_LIMIT = 40; // plafond anti-farming (nombre de rounds gagnés/jour) — sauté pour les comptes certifiés
const MINING_DILUTION_PER_BASE_REWARD = 0.00002; // -0.002 % de cours par tranche de récompense de base minée (÷15, le minage pesait bien trop sur le cours)
const MINING_MIN_MULTIPLIER = 0.85; // le cours ne peut pas descendre sous 85 % du prix de référence (au lieu de 40 %)
// Au-delà d'un facteur ~256 la cible (32 bits) plafonne à 1 sur la difficulté
// CPU max (6) — la palier la plus dure devient alors la difficulté maximale
// possible avec ce système ; les paliers plus faciles (4, 5) continuent, eux,
// de vraiment devenir plus durs avec ce facteur.
const MINING_GPU_DIFFICULTY_FACTOR = 300; // rounds GPU : cible ~300x plus dure que le CPU
// Récompense GPU globale divisée par 30 par rapport à l'ancienne valeur (base déjà
// divisée par 5 ci-dessus) : 10 / 3 × (1/5) → facteur GPU ramené à 5/3 sur la nouvelle base.
const MINING_GPU_REWARD_FACTOR = 5 / 3; // rounds GPU : récompense ~1,67x la base (au lieu de 10x)

/**
 * Échange NF <-> EUR interne : chaque échange déplace aussi le cours des deux
 * monnaies, façon pool de liquidité — vendre une monnaie (elle sort de la
 * circulation active) la renchérit, en acheter une (elle y entre) la dilue.
 * Symétrique au mécanisme de dilution du minage (même champ currentMultiplier),
 * proportionnel à la part de l'offre échangée : échanger 100 % de l'offre
 * d'un coup déplace le cours de EXCHANGE_PRICE_IMPACT_FACTOR, un échange plus
 * petit déplace le cours proportionnellement.
 */
const EXCHANGE_PRICE_IMPACT_FACTOR = 0.12;
const EXCHANGE_PRICE_MIN_MULTIPLIER = 0.85; // même plancher que le minage
const EXCHANGE_PRICE_MAX_MULTIPLIER = 3; // plafond haut, symétrique au plancher

/**
 * Casino (app Windows + tool agentique PolicierCongoV3) : mise → trésorerie,
 * gain ← trésorerie (masse monétaire inchangée, comme une dépense/récompense
 * classique). L'avantage maison vient du multiplicateur de gain : à chance de
 * gain W% et multiplicateur M, l'espérance du joueur est W% × M ; on choisit
 * M = (100/W) × (1 − CASINO_HOUSE_EDGE) pour que l'espérance soit toujours
 * strictement sous 1 (perte structurelle pour le joueur en moyenne, mais
 * gains réels et fréquents à court terme comme un vrai casino).
 */
const CASINO_HOUSE_EDGE = 0.18; // avantage maison ~18 %
const CASINO_MIN_BET_TWC = 0.1;
const CASINO_MAX_BET_TWC = 10000000;
const CASINO_MIN_WIN_CHANCE = 5; // %
const CASINO_MAX_WIN_CHANCE = 70; // %

/**
 * Roue : plus la mise se rapproche de CASINO_MAX_BET_TWC, plus la chance de
 * gain de base du mode (proportion de cases gagnantes sur la roue) est
 * multipliée — jusqu'à ce facteur à la mise max. Volontairement borné à une
 * valeur qui garde l'espérance du joueur sous 1 même au maximum
 * (CASINO_HOUSE_EDGE=0.18 → espérance de base 0.82 ; à ce facteur l'espérance
 * au max monte à ~0.94, donc la maison reste structurellement gagnante à
 * long terme, mais nettement moins qu'à mise faible) : miser plus donne une
 * vraie meilleure chance de gagner CE tour, sans transformer la roue en
 * martingale exploitable.
 */
const CASINO_WHEEL_MAX_WIN_SCALE = 1.15;

/**
 * Détecteur de fraude P2P (p2pFraudDetector.js) — seuils des signaux calculés
 * sur le graphe réel des transferts en base (voir ce fichier pour le détail
 * de chaque signal). Remplace `checkTransaction` (pensé pour les paiements
 * carte) sur la route de virement entre utilisateurs.
 */
const P2P_VELOCITY_WINDOW_MIN = 10;       // fenêtre de vélocité
const P2P_VELOCITY_REVIEW_COUNT = 5;      // virements sortants dans la fenêtre → review
const P2P_VELOCITY_BLOCK_COUNT = 12;      // virements sortants dans la fenêtre → block
const P2P_SAME_RECIPIENT_WINDOW_MIN = 60; // fenêtre pour la répétition vers un même destinataire
const P2P_SAME_RECIPIENT_MAX_COUNT = 4;   // virements vers le même destinataire dans la fenêtre → flag
const P2P_FANIN_WINDOW_MIN = 60;          // fenêtre pour la détection de compte "mule"
const P2P_FANIN_MAX_SENDERS = 5;          // expéditeurs distincts vers un même destinataire → flag
const P2P_CIRCULAR_WINDOW_HOURS = 24;     // fenêtre pour détecter un aller-retour A→B→A
const P2P_CIRCULAR_AMOUNT_TOLERANCE = 0.2; // écart relatif max entre les deux sens pour matcher "comparable"
const P2P_NEW_RECIPIENT_BALANCE_RATIO = 0.5; // part du solde envoyée à un tout nouveau destinataire → flag
const P2P_DRAIN_BALANCE_RATIO = 0.9;      // part du solde vidée par ce virement → signal de drain
const P2P_DRAIN_HISTORICAL_MULTIPLE = 3;  // multiple du plus gros virement historique pour confirmer l'anomalie
const P2P_BLOCK_SCORE = 70;               // score ≥ → virement bloqué
const P2P_REVIEW_SCORE = 35;              // score ≥ → virement autorisé mais flaggé pour revue

module.exports = {
  TREASURY_USER_ID,
  REFERENCE_PRICE_EUR,
  SYMBOL,
  PURCHASE_PACKAGES,
  MIN_TRANSFER_TWC,
  MIN_SPEND_TWC,
  MIN_REWARD_TWC,
  P2P_TRANSFER_FEE_RATE,
  P2P_TRANSFER_FEE_RATE_SUBSCRIBER,
  P2P_TRANSFER_FEE_RATE_ULTRA,
  MINING_BASE_REWARD_TWC,
  MINING_DAILY_WIN_LIMIT,
  MINING_DILUTION_PER_BASE_REWARD,
  MINING_MIN_MULTIPLIER,
  MINING_GPU_DIFFICULTY_FACTOR,
  MINING_GPU_REWARD_FACTOR,
  EXCHANGE_PRICE_IMPACT_FACTOR,
  EXCHANGE_PRICE_MIN_MULTIPLIER,
  EXCHANGE_PRICE_MAX_MULTIPLIER,
  CASINO_HOUSE_EDGE,
  CASINO_MIN_BET_TWC,
  CASINO_MAX_BET_TWC,
  CASINO_MIN_WIN_CHANCE,
  CASINO_MAX_WIN_CHANCE,
  CASINO_WHEEL_MAX_WIN_SCALE,
  P2P_VELOCITY_WINDOW_MIN,
  P2P_VELOCITY_REVIEW_COUNT,
  P2P_VELOCITY_BLOCK_COUNT,
  P2P_SAME_RECIPIENT_WINDOW_MIN,
  P2P_SAME_RECIPIENT_MAX_COUNT,
  P2P_FANIN_WINDOW_MIN,
  P2P_FANIN_MAX_SENDERS,
  P2P_CIRCULAR_WINDOW_HOURS,
  P2P_CIRCULAR_AMOUNT_TOLERANCE,
  P2P_NEW_RECIPIENT_BALANCE_RATIO,
  P2P_DRAIN_BALANCE_RATIO,
  P2P_DRAIN_HISTORICAL_MULTIPLE,
  P2P_BLOCK_SCORE,
  P2P_REVIEW_SCORE
};
