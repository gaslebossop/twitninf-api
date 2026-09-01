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
 * Même prélèvement pour un créateur Ultra : 20 %, donc 80 % pour lui.
 *
 * Ultra est le palier des gros vendeurs — c'est là que dix points de
 * commission représentent une vraie somme, et c'est le seul endroit où la
 * remise se paie d'elle-même. Le taux est FIGÉ SUR LE VERROU à sa création
 * (`platform_fee_rate` du lock, relu tel quel à l'achat) : une vente déjà en
 * ligne ne change pas de commission parce que l'auteur s'est abonné ou
 * désabonné entre-temps.
 */
const PLATFORM_CONTENT_FEE_RATE_ULTRA = 0.20;

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

/** Même remise Ultra que sur le contenu, pour la même raison, et au même taux. */
const PLATFORM_USERNAME_FEE_RATE_ULTRA = 0.20;

/** Bornes de prix d'un contenu à l'unité, en NF. */
const PAID_CONTENT_MIN_PRICE_TWC = 0.05;
const PAID_CONTENT_MAX_PRICE_TWC = 500;
/**
 * Ultra peut vendre jusqu'à 5 000 NF l'unité.
 *
 * Le plafond commun protège surtout l'acheteur d'une erreur de saisie du
 * vendeur. Au palier où l'on vend une formation ou une prestation complète,
 * 500 NF n'est plus un garde-fou, c'est un plafond de verre.
 */
const PAID_CONTENT_MAX_PRICE_TWC_ULTRA = 5000;

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
/** Ultra tient ses réservations un trimestre, pour le même prix unitaire. */
const USERNAME_RESERVATION_DAYS_ULTRA = 90;
const USERNAME_RESERVATION_MAX_PER_USER = 5;

/**
 * Ultra peut en tenir 20.
 *
 * Le plafond existe contre la préemption en masse des pseudos courts. Il
 * tient toujours à 20 : la réservation reste payante et expire au bout de
 * `USERNAME_RESERVATION_DAYS`, donc immobiliser vingt noms coûte vingt fois
 * le prix, tous les trente jours. C'est une marge de manoeuvre pour une
 * marque qui protège ses variantes, pas une porte ouverte.
 */
const USERNAME_RESERVATION_MAX_PER_USER_ULTRA = 20;

/**
 * Délai pendant lequel le prix d'un contenu reste modifiable, à partir de sa
 * mise en vente.
 *
 * Même durée que la fenêtre d'édition d'un tweet, et pour la même raison :
 * passé ce délai, des gens ont vu le contenu à un prix. Le changer ensuite,
 * c'est déplacer l'étiquette sur un article que les clients ont déjà examiné
 * — et si le prix baisse, ceux qui ont payé plein tarif la veille n'ont aucun
 * recours.
 *
 * Ce qui reste possible à tout moment : RETIRER le verrou (rendre gratuit).
 * Ça ne lèse personne — les acheteurs gardent leur accès, et les autres y
 * gagnent.
 */
const PAID_CONTENT_PRICE_EDIT_WINDOW_MS = 30 * 60 * 1000;

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

/**
 * Ultra en obtient 10 — et c'est le SEUL curseur d'édition qui bouge pour lui.
 *
 * La fenêtre de 30 minutes, elle, ne bouge pas : elle protège les gens qui ont
 * retweeté un texte précis, et ça ne s'achète pas. Le nombre de révisions ne
 * protège personne (l'historique est public et le reste), il évite seulement
 * qu'un tweet devienne une ardoise. Dix corrections en une demi-heure, c'est
 * toujours borné.
 */
const TWEET_EDIT_MAX_REVISIONS_ULTRA = 10;

/** Programmation : horizon maximal et taille de la file par compte. */
const SCHEDULE_MAX_HORIZON_DAYS = 60;
const SCHEDULE_MAX_PENDING = 50;
/**
 * Programmation Ultra : six mois d'avance et 200 tweets en file.
 *
 * Les deux bornes servent à ne pas laisser un compte accumuler une file
 * ingérable, pas à rationner la fonctionnalité. Un créateur qui prépare une
 * saison entière tape dans les deux à la fois — d'où le relèvement conjoint.
 */
const SCHEDULE_MAX_HORIZON_DAYS_ULTRA = 180;
const SCHEDULE_MAX_PENDING_ULTRA = 200;
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
 * Ultra voit les 30 jours — soit exactement TOUT ce qui est conservé.
 *
 * Rien de nouveau n'est collecté ni gardé plus longtemps : la rétention reste
 * `PROFILE_VIEW_RETENTION_DAYS`, l'avantage est de pouvoir lire ce qui est
 * déjà là. C'est la limite haute à ne jamais dépasser — au-delà, il faudrait
 * garder les visites plus longtemps, et la donnée ne servirait plus qu'à
 * profiler quelqu'un.
 */
const PROFILE_VIEW_WINDOW_DAYS_ULTRA = PROFILE_VIEW_RETENTION_DAYS;

/**
 * Décollage d'un tweet : le multiple du rythme habituel de l'auteur à partir
 * duquel on le prévient, et le délai minimal entre deux alertes sur un même
 * tweet.
 */
const VELOCITY_ALERT_MULTIPLIER = 3;
/**
 * Ultra est prévenu dès le double de son rythme, pas le triple.
 *
 * L'intérêt d'une alerte de décollage est de pouvoir ENCORE agir — relancer,
 * répondre, enchaîner. Un cran plus tôt, c'est une demi-heure de marge sur un
 * tweet qui monte, et c'est là que se joue toute la valeur du signal.
 */
const VELOCITY_ALERT_MULTIPLIER_ULTRA = 2;
const VELOCITY_ALERT_MIN_ENGAGEMENTS = 10;
const VELOCITY_ALERT_MAX_TWEET_AGE_MS = 48 * 60 * 60 * 1000;

/** Usurpation : seuil de ressemblance des pseudos (0–1) et âge max du compte visé. */
const IMPERSONATION_SIMILARITY_THRESHOLD = 0.72;
const IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS = 120;
/**
 * Ultra : la surveillance d'usurpation remonte à un an.
 *
 * Un usurpateur patient crée son compte longtemps avant de s'en servir,
 * précisément pour sortir de la fenêtre de scan. Les comptes les plus copiés
 * sont ceux du palier du haut : c'est là que la fenêtre courte coûte le plus.
 */
const IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS_ULTRA = 365;

module.exports = {
  PLATFORM_CONTENT_FEE_RATE,
  PLATFORM_CONTENT_FEE_RATE_ULTRA,
  PLATFORM_USERNAME_FEE_RATE,
  PLATFORM_USERNAME_FEE_RATE_ULTRA,
  PAID_CONTENT_MIN_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC_ULTRA,
  PAID_CONTENT_PRICE_EDIT_WINDOW_MS,
  USERNAME_MIN_PRICE_TWC,
  USERNAME_MAX_PRICE_TWC,
  USERNAME_RESERVATION_PRICE_TWC,
  USERNAME_RESERVATION_DAYS,
  USERNAME_RESERVATION_DAYS_ULTRA,
  USERNAME_RESERVATION_MAX_PER_USER,
  USERNAME_RESERVATION_MAX_PER_USER_ULTRA,
  TWEET_EDIT_WINDOW_MS,
  TWEET_EDIT_MAX_REVISIONS,
  TWEET_EDIT_MAX_REVISIONS_ULTRA,
  SCHEDULE_MAX_HORIZON_DAYS,
  SCHEDULE_MAX_HORIZON_DAYS_ULTRA,
  SCHEDULE_MAX_PENDING,
  SCHEDULE_MAX_PENDING_ULTRA,
  SCHEDULE_MIN_LEAD_MS,
  PROFILE_VIEW_RETENTION_DAYS,
  PROFILE_VIEW_WINDOW_DAYS,
  PROFILE_VIEW_WINDOW_DAYS_ULTRA,
  VELOCITY_ALERT_MULTIPLIER,
  VELOCITY_ALERT_MULTIPLIER_ULTRA,
  VELOCITY_ALERT_MIN_ENGAGEMENTS,
  VELOCITY_ALERT_MAX_TWEET_AGE_MS,
  IMPERSONATION_SIMILARITY_THRESHOLD,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS_ULTRA,
};
