/**
 * Règles communes aux fonctionnalités payantes lancées avec l'offre créateur :
 * contenu à l'unité, marché des pseudos, programmation, édition.
 *
 * Tout ce qui touche à un montant est ici et nulle part ailleurs. Une
 * commission recopiée dans deux fichiers finit toujours par diverger, et la
 * divergence porte alors sur ce que la plateforme prélève réellement à un
 * créateur — c'est-à-dire sur de l'argent, pas sur un libellé.
 */

/**
 * Part prélevée par TwitNinf sur une vente de contenu à l'unité.
 *
 * Le créateur touche donc 70 %. C'est le chiffre annoncé dans l'app ; le
 * calcul réel est fait côté serveur au moment de l'écriture au grand livre,
 * jamais depuis un montant fourni par le client.
 */
const PLATFORM_CONTENT_FEE_RATE = 0.30;

/**
 * Même taux sur la vente d'un pseudo.
 *
 * On aurait pu le rapprocher des frais de virement P2P (20 / 10 %), mais un
 * pseudo n'est pas un virement : c'est un actif que la plateforme émet,
 * arbitre et garantit — y compris en refusant une vente pour usurpation. Le
 * taux de la vente de contenu est le bon repère, et un seul taux à expliquer
 * vaut mieux que deux.
 */
const PLATFORM_USERNAME_FEE_RATE = 0.30;

/** Bornes de prix d'un contenu à l'unité, en NF. */
const PAID_CONTENT_MIN_PRICE_TWC = 0.05;
const PAID_CONTENT_MAX_PRICE_TWC = 500;

/** Bornes de prix d'un pseudo mis en vente, en NF. */
const USERNAME_MIN_PRICE_TWC = 0.5;
const USERNAME_MAX_PRICE_TWC = 100000;

/**
 * Coût de réservation d'un pseudo libre, et durée de la réservation.
 *
 * Payante et limitée dans le temps à dessein : gratuite et illimitée, elle
 * serait immédiatement utilisée pour préempter en masse tous les pseudos
 * courts, ce qui tuerait le marché avant qu'il n'existe.
 */
const USERNAME_RESERVATION_PRICE_TWC = 2;
const USERNAME_RESERVATION_DAYS = 30;
const USERNAME_RESERVATION_MAX_PER_USER = 5;

/**
 * Aperçu laissé visible au-dessus du verrou.
 *
 * Un contenu payant dont on ne voit rien ne se vend pas, et un contenu dont
 * on voit tout non plus. 140 caractères : de quoi comprendre le sujet, pas
 * de quoi s'en passer.
 */
const PAID_CONTENT_PREVIEW_CHARS = 140;

/**
 * Fenêtre d'édition d'un tweet publié.
 *
 * 30 minutes après la publication, et pas une de plus : passé ce délai, des
 * gens ont retweeté, cité et répondu à un texte précis. Le modifier
 * ensuite, c'est réécrire ce qu'ils ont approuvé.
 */
const TWEET_EDIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Nombre d'éditions autorisées sur un même tweet.
 *
 * L'historique est public : la limite n'est pas là pour empêcher la triche
 * (l'historique s'en charge) mais pour éviter qu'un tweet très vu ne devienne
 * une ardoise qu'on réécrit en boucle.
 */
const TWEET_EDIT_MAX_REVISIONS = 5;

/** Programmation : horizon maximal et taille de la file par compte. */
const SCHEDULE_MAX_HORIZON_DAYS = 60;
const SCHEDULE_MAX_PENDING = 50;
/** En dessous de cette avance, on publie tout de suite plutôt que d'attendre. */
const SCHEDULE_MIN_LEAD_MS = 60 * 1000;

/**
 * Rétention des visites de profil.
 *
 * Les visites sont agrégées par (visiteur, jour) : on garde qui, pas combien
 * de fois ni à quelle seconde. Sept jours, c'est ce que l'app affiche — au
 * delà, la donnée ne sert plus qu'à profiler quelqu'un.
 */
const PROFILE_VIEW_RETENTION_DAYS = 30;
const PROFILE_VIEW_WINDOW_DAYS = 7;

/**
 * Décollage d'un tweet : le multiple du rythme habituel de l'auteur à partir
 * duquel on le prévient, et le délai minimal entre deux alertes sur un même
 * tweet.
 */
const VELOCITY_ALERT_MULTIPLIER = 3;
const VELOCITY_ALERT_MIN_ENGAGEMENTS = 10;
const VELOCITY_ALERT_MAX_TWEET_AGE_MS = 48 * 60 * 60 * 1000;

/** Usurpation : seuil de ressemblance des pseudos (0–1) et âge max du compte visé. */
const IMPERSONATION_SIMILARITY_THRESHOLD = 0.72;
const IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS = 120;

module.exports = {
  PLATFORM_CONTENT_FEE_RATE,
  PLATFORM_USERNAME_FEE_RATE,
  PAID_CONTENT_MIN_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC,
  PAID_CONTENT_PREVIEW_CHARS,
  USERNAME_MIN_PRICE_TWC,
  USERNAME_MAX_PRICE_TWC,
  USERNAME_RESERVATION_PRICE_TWC,
  USERNAME_RESERVATION_DAYS,
  USERNAME_RESERVATION_MAX_PER_USER,
  TWEET_EDIT_WINDOW_MS,
  TWEET_EDIT_MAX_REVISIONS,
  SCHEDULE_MAX_HORIZON_DAYS,
  SCHEDULE_MAX_PENDING,
  SCHEDULE_MIN_LEAD_MS,
  PROFILE_VIEW_RETENTION_DAYS,
  PROFILE_VIEW_WINDOW_DAYS,
  VELOCITY_ALERT_MULTIPLIER,
  VELOCITY_ALERT_MIN_ENGAGEMENTS,
  VELOCITY_ALERT_MAX_TWEET_AGE_MS,
  IMPERSONATION_SIMILARITY_THRESHOLD,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS,
};
