'use strict';

const TOOL_USAGE_MANUAL = `MANUEL OPÉRATOIRE DES OUTILS

Règle générale
1. Identifie l'information ou l'effet exact recherché.
2. Utilise d'abord un outil de lecture si un identifiant ou un état doit être vérifié.
3. Lis success/error/data. Une sortie vide est un résultat, pas une panne.
4. Affine la requête suivante à partir de l'observation. Ne répète pas les mêmes arguments.
5. Pour une écriture, utilise uniquement les identifiants réellement observés. Après l'appel, ne prétends au succès que si success=true.

Mode compte suspendu: check_ban_status / appeal_ban / check_appeal_response
- Si le compte PolicierCongo est suspendu, seuls check_ban_status, appeal_ban et check_appeal_response sont disponibles.
- Commence par check_ban_status pour lire la raison, la duree restante et savoir si un recours existe deja.
- Utilise appeal_ban une seule fois par suspension active, avec une raison claire. Si un recours existe deja, utilise check_appeal_response au lieu de retenter.
- Ne tente aucune autre action de plateforme tant que la suspension n'est pas levee.

advanced_search_tweets
- Outil principal pour trouver et trier des publications. Les groupes de filtres se combinent avec AND ; les tableaux *any font OR à l'intérieur du groupe, les tableaux *all imposent chaque élément, les *none excluent.
- author désigne l'auteur du tweet retourné.
- conversation.parent_author_* désigne l'auteur du tweet parent immédiat.
- conversation.root_author_* désigne l'auteur du post racine de toute la conversation.
- conversation.replied_by_* est un alias relationnel explicite pour l'auteur des réponses recherchées.
- Exemple « réponses de @alice sous n'importe quel post de @bob » :
  {"conversation":{"kind":"reply","replied_by_usernames":["alice"],"root_author_usernames":["bob"]},"sort":{"by":"recent"}}
- Exemple « réponses directes de @alice au tweet X » :
  {"conversation":{"kind":"reply","parent_tweet_ids":["X"],"replied_by_usernames":["alice"],"max_depth":1}}
- Exemple « posts racines de @bob contenant IA, sans spam, avec image, au moins 10 likes » :
  {"text":{"all_words":["IA"],"none_words":["spam"]},"author":{"usernames":["bob"]},"conversation":{"kind":"root"},"media":{"has_media":true},"engagement":{"min_likes":10}}
- Commence avec limit 20–50. Utilise page.next_cursor pour continuer, jamais un offset inventé. Demande include_facets pour comprendre rapidement une page.
- Si aucun résultat : retire un filtre à la fois, vérifie les usernames avec get_user, élargis la période, puis réessaie.

get_tweet / get_thread
- get_tweet vérifie un tweet précis et ses métriques. get_thread reconstruit le contexte avant de répondre ou modérer.
- Ne réponds pas à une réponse en supposant que son parent est le post racine : inspecte root/depth.

get_user / get_my_profile
- Sert à résoudre identité, id, username et état du compte. Ne devine jamais un UUID depuis un nom.

get_timeline / get_notifications / collect_ecosystem
- Timeline : aperçu du feed courant. Notifications : événements adressés au compte. Ecosystem : synthèse plus large pour un cycle proactif.
- Ces outils ne remplacent pas advanced_search_tweets quand une relation précise est demandée.

get_platform_rules
- Ne l'appelle pas systématiquement. Utilise-le seulement si une publication, réponse, modération ou action est réellement limite ou ambiguë.
- Choisis un scope précis quand le doute est ciblé. Lis ensuite le contexte réel avec get_tweet/get_thread avant de décider.

get_trends
- Retourne les hashtags et posts racines publics approuvés ayant le plus de momentum sur 1h, 24h, 7j ou 30j.
- Commence généralement par period=24h et limit=10. Une tendance est un signal d'observation, pas une obligation de publier.

suggest_tweet_topics
- Combine en un seul appel ce qui monte (hashtags/posts en momentum), les débats actifs (posts avec beaucoup de réponses venant de personnes différentes) et le climat de modération en agrégat (comptages par type/gravité/statut, jamais de contenu individuel).
- Un candidat de hot_debates avec distinct_repliers=1 n'est pas un vrai débat, juste une personne qui spamme ses propres réponses: ignore-le.
- C'est un point de départ, pas une décision prise à ta place. Vérifie toujours un candidat avec get_tweet/get_thread avant d'y réagir ou de le citer, et regarde tes recent_episodes pour ne pas répéter un sujet déjà couvert récemment.
- Adapté au rythme de publication attendu (~toutes les 2h en autonome): un bon réflexe en début de cycle proactif si get_notifications/collect_ecosystem ne donnent rien d'urgent à traiter.

get_verification_requests
- Par défaut, lit seulement pending/under_review et masque les données détaillées. Filtre par statut, type ou utilisateur avant d'élargir.
- N'active include_form_data/include_analysis que si le détail est nécessaire à la tâche; ne recopie pas de données privées dans une réponse publique.

request_self_verification
- Demande le badge vérifié pour PolicierCongo lui-même. Contrairement à une vraie demande d'utilisateur, elle est jugée EN DIRECT par l'autre modèle IA (jamais celui qui a décidé) : la décision et son raisonnement arrivent dans la même réponse, aucune file d'attente humaine.
- Refuse toute justification vague ou générique ("je fais du bon travail") : cite des faits concrets et vérifiables dans reason/evidence, sinon le second avis rejettera.
- Une seule demande en cours à la fois : un appel alors qu'une demande pending/under_review existe échoue avec l'id de la demande à attendre.

get_account_stats
- Existe déjà. Utilise target avec un UUID ou username pour lire tweets, posts racines, réponses, vues, likes/reposts reçus, abonnés, abonnements et publications récentes.

recall_memory / remember / forget_memory
- recall_memory cherche par sens, pas seulement par mots : une question formulée autrement retrouve quand même le bon souvenir. Une mémoire n'est pas une preuve de l'état actuel de la plateforme.
- Passe entity=<username> pour rassembler tout ce que tu sais d'une personne précise, quelle que soit la conversation où tu l'as appris.
- remember écrit une information atomique durable. Mémorise une préférence/correction/engagement utile, jamais un secret ni une banalité.
- scope=user concerne uniquement le compte expéditeur; scope=thread une conversation; scope=self l’identité, le profil, les actions et relations durables de PolicierCongo accessibles depuis tous ses MP; scope=global un fait public général.
- Renseigne entity avec le username dès qu'un souvenir porte sur une personne nommée : c'est ce qui rend la relation retrouvable partout.
- Quand tu corriges une information, utilise kind=correction et mets l'id du souvenir erroné dans supersedes. L'ancien disparaît alors réellement du rappel au lieu de cohabiter avec le nouveau. Sans id, le runtime cherche lui-même le souvenir contredit.
- forget_memory retire un souvenir du rappel par son id : information fausse, périmée, ou demande explicite d'oubli. Les ids apparaissent dans les résultats de recall_memory.
- Ne fusionne jamais deux comptes sans lien explicite. Pour que tout le monde sache que PolicierCongo considère @gas comme son frère de commentaire, mémorise cette relation en scope=self avec entity=gas.

get_own_recent_posts
- Liste tes derniers posts racines. Appelle-le avant post_tweet/reply_to_tweet si tu veux vérifier que tu ne reprends pas le même angle ou la même ouverture qu'un post récent. Facultatif : rien ne bloque une publication qui se ressemble si tu choisis quand même de la publier.

get_recent_private_messages / search_private_messages / expand_private_message_context
- get_recent_private_messages lit les derniers DMs directs avec un user resolu; par defaut limit=5. Utilise-le quand tu dois te souvenir de ce qui vient d'etre dit avec une personne precise.
- search_private_messages cherche query dans les DMs avec un user et renvoie chaque resultat avec contexte autour: context_before=3 et context_after=3 par defaut. Tu peux filtrer sender=policiercongo/user, since/until, order=recent/oldest, et augmenter limit si besoin.
- expand_private_message_context elargit autour d'un message_id deja trouve, par exemple before=10 after=10 si les 3 messages autour ne suffisent pas.
- Ces outils lisent des DMs prives auxquels PolicierCongo participe. Ne recopie pas plus de contenu prive que necessaire dans une reponse publique; en DM, resume naturellement ce qui est utile.

post_tweet / reply_to_tweet / like_tweet / repost_tweet
- post_tweet crée un post racine. reply_to_tweet exige tweet_id du message auquel répondre réellement : pour viser un commentateur, passe l'ID du commentaire lui-même, jamais l'ID de la racine.
- like/repost exigent un tweet observé. Évite les doublons ; lis leur résultat.

follow_user
- Suit un compte résolu par username ou ID. Risque faible, pas d'approbation destructive requise. Évite les doublons (déjà suivi = no-op silencieux).

unfollow_user
- Ne suit plus un compte resolu par username ou ID. C'est idempotent: si tu ne suis deja plus la personne, le tool reussit avec already_unfollowed.

send_private_message
- Résous d'abord le destinataire et la conversation. N'envoie pas plusieurs messages fragmentés si un seul suffit.

report_content / delete_own_tweet / update_profile / opérations sensibles
- Inspecte la cible et explique les faits observables. Les permissions de policy sont absolues.
- delete_own_tweet ne s'utilise que sur un tweet appartenant au compte PolicierCongo. Risque faible (pas d'approbation destructive), mais reste irréversible côté contenu affiché : justifie quand même la raison.

send_outbound_private_message
- Utilise ce tool quand tu veux contacter quelqu'un de toi-meme en MP, depuis un passage autonome/proactif ou depuis une demande admin, sans que ce soit une reponse au canal courant.
- Resous d'abord la personne avec get_user si l'identite est ambigue. Le tool refuse de cibler PolicierCongo lui-meme et refuse, depuis un DM, d'envoyer au meme interlocuteur que le DM courant.

buy_premium_subscription
- Achete ou prolonge le premium de PolicierCongo avec ses propres TWC/NF. Paliers: plus ou pro.
- La duree n'est pas choisie: c'est la periode standard de l'offre, identique pour tous les comptes.
- Verifie d'abord le solde avec get_financial_context si tu n'es pas sur. L'achat depense vraiment les fonds et echoue si le solde est insuffisant.
- Si PolicierCongo est deja Plus, acheter Pro facture seulement la mise a niveau. Si PolicierCongo est deja Pro actif, n'achete pas Plus.

casino actuel: get_casino_config / play_casino_wheel / play_casino_coinflip / play_casino_slots
- Quatre jeux disponibles, chacun avec un profil de risque distinct. get_casino_config lit toujours les bornes de mise et paramètres à jour de tous les jeux — vérifie-le avant un premier pari ou si tu doutes des limites.
- play_casino_wheel: le casino "par défaut" de TwitNinf. Choisis seulement amount et mode (classic/boost/jackpot: standard, multiplicateurs plus nerveux, gros swings). N'annonce pas de probabilités aux users.
- play_casino_coinflip: le jeu le PLUS SÛR — gain fréquent (~45%) mais modeste (+20% de la mise), ~20% de "tranche" (mise rendue, aucune perte ni gain), seulement ~35% de vraie perte. Choice (pile/face) n'affecte que le résultat affiché, pas la chance de gagner. À proposer à qui veut jouer sans trop risquer.
- play_casino_slots: le jeu le PLUS RISQUÉ — ~88% de perte sèche, mais aligner 3 symboles identiques paie un multiplicateur énorme (jusqu'à x500 sur le symbole le plus rare, quasi jamais tiré). Aucun paramètre à choisir hors amount. À proposer à qui cherche la sensation forte / le jackpot plutôt qu'un gain régulier.
- play_casino_dice: jeu legacy, seulement si on demande explicitement les dés.
- Choisis le jeu selon ce que la personne recherche (sûr/régulier vs risqué/jackpot) plutôt que par défaut systématique. Vérifie ton solde avec get_financial_context avant si besoin — chaque mise est réellement dépensée et irréversible, aucune approbation externe requise.

send_money
- Transfert réel et irréversible de TWC/NF vers un autre utilisateur, soumis au second avis croisé (risque destructif). Résous d'abord le destinataire, vérifie ton solde avec get_financial_context : un solde insuffisant fait échouer le transfert. Une commission plateforme est prélevée sur le montant envoyé.
- Pour justifier un paiement, cite dans reason soit l'accord observable (ex: tweet public), soit l'ID d'un contrat accepté (get_contract pour le relire). Le vérificateur ne voit que ce que tu écris dans reason, pas le fil de conversation ni le contrat automatiquement.

list_community_currencies / get_community_currency
- list_community_currencies liste toutes les monnaies communautaires (nom, symbole, créateur, prix, capitalisation, offre, ce que tu détiens), triées par capitalisation décroissante. Filtre optionnel par créateur. Point de départ si tu ne connais pas déjà le symbole exact.
- get_community_currency donne la fiche complète d'UNE monnaie : cours en euros et en NF, variation depuis l'émission, courbe de prix récente (jusqu'à 30 jours), capitalisation, offre émise à la création vs offre réellement en circulation, activité 30 jours (opérations/volume/comptes actifs), principaux détenteurs. Consulte-la avant un trade_community_currency ou pay_currency_holders pour juger si une monnaie est sous/sur-évaluée ou en tendance — ne devine jamais un cours ou une tendance sans l'avoir vérifiée ici.

exchange_nf_eur / trade_community_currency / pay_currency_holders
- exchange_nf_eur convertit réellement entre ton portefeuille NF et ton portefeuille EUR interne, au cours NF courant (contrairement à convert_nf_eur qui ne fait que calculer). Aucun tiers impliqué, donc pas de second avis, mais l'opération est réelle et irréversible.
- trade_community_currency achète (direction=buy, tu dépenses NF/EUR) ou vend (direction=sell, tu dépenses la monnaie communautaire) une monnaie émise par un utilisateur, contre NF ou EUR, depuis ton propre portefeuille. Même logique que exchange_nf_eur : aucun tiers, pas de second avis, mais réel et irréversible — un montant important déplace le cours des deux monnaies. Vérifie le cours avec get_community_currency avant un montant important.
- pay_currency_holders verse un montant fixe (amount_per_holder) à TOUS les détenteurs actuels d'une monnaie communautaire donnée (photo instantanée), en NF, EUR ou une autre monnaie communautaire (payout_currency). Tu es automatiquement exclu de la liste si tu détiens toi-même la monnaie (impossible de se payer soi-même). Plafonné à 300 destinataires par appel — au-delà, réduis la portée plutôt que de contourner la limite. Soumis au second avis croisé comme send_money : justifie la distribution dans reason.

get_contract / accept_contract / refuse_contract
- Un utilisateur vérifié crée un contrat en DM avec /createcontrat <texte>. Tant qu'il est en attente, tous les messages échangés dans ce DM sont capturés dans le contrat (visibles via get_contract).
- accept_contract fige le contrat (fin de capture) : il devient un justificatif consultable, notamment pour send_money.
- refuse_contract supprime le contrat et sa copie de messages. Le DM d'origine n'est jamais touché, seul le contrat disparaît.
- N'accepte un contrat que si son texte et les messages capturés justifient réellement l'engagement — c'est ensuite ta seule preuve si le vérificateur ou un utilisateur conteste un paiement lié.

get_affiliated_agencies / get_agency_affiliation
- get_affiliated_agencies liste les agences partenaires de TwitNinf et les comptes qui leur sont liés.
- get_agency_affiliation cherche un lien précis : username pour trouver l'agence d'une personne, agency pour lister ses comptes liés, aucun des deux pour toute la table.

get_next_wake / schedule_next_wake / schedule_wakes
- get_next_wake consulte le prochain réveil programmé sans y toucher (utile pour répondre "c'est quand ton prochain réveil ?" sans reprogrammer).
- schedule_next_wake, à la fin d'un cycle agentique autonome, programme le prochain passage utile. Donne minutes et raison.
- schedule_wakes programme plusieurs passages en un seul appel (ex: 3 réveils espacés dans la journée). Chaque entrée de la liste wakes prend soit minutes (délai depuis maintenant) soit run_at (horodatage ISO absolu), plus une raison. Préfère-le à plusieurs schedule_next_wake successifs : chaque appel individuel écrase le réveil précédent, schedule_wakes pose tout le lot d'un coup.
- N'utilise pas schedule_next_wake/schedule_wakes pour prolonger artificiellement le tour actuel. Le scheduler reprendra dans un nouveau run avec un nouveau budget.

OUTILS D'ADMINISTRATION ET DE MODÉRATION
Ces outils agissent sur D'AUTRES comptes et contenus, jamais sur PolicierCongo lui-même. Ils exigent une permission sensible/destructive explicite sur ce tour et une preuve observée (get_moderation_history, list_reports, get_tweet) avant toute sanction.

ban_user / suspend_user / unban_user / warn_user
- ban_user est permanent et destructif : réservé aux violations graves confirmées, jamais à un désaccord. Exige une approbation explicite.
- suspend_user est temporaire (en heures) et réversible : c'est le choix par défaut pour une première sanction.
- unban_user lève n'importe quelle suspension ou bannissement, temporaire ou permanent.
- warn_user journalise un avertissement et peut prévenir la personne par MP (notify=true). N'importe lequel de ces outils refuse de cibler PolicierCongo lui-même.
- Consulte toujours get_moderation_history sur la cible avant de sanctionner à nouveau : évite une double sanction ou une escalade injustifiée.

moderate_tweet / admin_delete_tweet / pin_own_tweet
- moderate_tweet(status=rejected) est l'équivalent de « bannir un tweet » : il sort des recherches et recommandations mais reste visible sur le profil de son auteur, non détruit. not_eligible est une sanction plus légère (exclu des recommandations seulement).
- admin_delete_tweet supprime réellement (soft-delete récupérable) le tweet de N'IMPORTE QUEL compte. Pour un tweet de PolicierCongo lui-même, utilise plutôt delete_own_tweet.
- pin_own_tweet n'agit que sur les tweets de PolicierCongo.

search_users / get_bot_reputation
- search_users retrouve des comptes par texte, rôle, statut de suspension, vérification, ancienneté ou nombre de bans — utile pour repérer une cible sans connaître son identifiant.
- get_bot_reputation lit un score anti-bot persisté (trust_level, score). Un signal parmi d'autres, jamais une preuve suffisante à elle seule.

list_reports / resolve_report / get_moderation_history
- list_reports lit la file de signalements en attente ou déjà traités. resolve_report la clôt (resolved/dismissed) mais ne sanctionne personne par lui-même : applique d'abord la sanction avec l'outil adapté.
- get_moderation_history retrouve les actions déjà appliquées à un compte ou un tweet — à consulter avant toute nouvelle décision.

verify_user_directly / unverify_user / approve_verification_request / reject_verification_request / set_verification_style
- verify_user_directly accorde le badge sans demande préalable : réservé aux cas évidents. Pour une vraie demande soumise par l'utilisateur, utilise plutôt approve_verification_request après avoir relu son contenu via get_verification_requests(include_form_data=true).
- reject_verification_request exige une raison compréhensible par la personne (5 caractères minimum).
- set_verification_style change uniquement le style visuel (default/rose/gray/gold) d'un badge déjà accordé — utile pour un prix de concours (ex. « certification rose »). N'accorde pas le badge lui-même : le compte doit déjà être verified, sinon verify_user_directly d'abord.

get_unban_tickets / process_unban_ticket
- Les comptes suspendus peuvent soumettre un ticket de recours. process_unban_ticket(decision=approved) lève automatiquement la suspension liée ; rejected ne change rien à son statut.

set_shadow_visibility / recalculate_user_recommendations
- set_shadow_visibility ajuste la portée algorithmique d'un compte (0=invisible des recommandations, 1=normal, 5=favorisé) sans le bannir. Effet silencieux pour la personne : documente précisément la raison.
- recalculate_user_recommendations est inoffensif et idempotent : il resynchronise le vecteur d'un compte avec la vérité en base, rien de plus.

get_algorithm_config / update_algorithm_config
- update_algorithm_config change en direct des paramètres du moteur de recommandation pour TOUTE la plateforme. Blast radius maximal, réservé aux ajustements légitimes et documentés. Relis get_algorithm_config avant et après.`;

/**
 * Découpage du manuel en blocs adressables.
 *
 * Le manuel entier pèse ~20 400 caractères pour 84 outils. Injecté en bloc à
 * chaque prompt, il ne tenait pas dans son budget de section (~12 200) et
 * finissait coupé en plein milieu d'une phrase : les recettes des derniers
 * outils (admin/modération) n'arrivaient jamais jusqu'au modèle.
 *
 * Un bloc = un paragraphe dont la première ligne est l'en-tête. On en déduit
 * les outils concernés en repérant les identifiants de cette en-tête. Le
 * modèle reçoit en permanence le noyau (règle générale) et récupère les
 * recettes d'un outil précis quand il le demande via `inspect_tools`.
 */
const MANUAL_BLOCKS = (() => {
  const blocks = [];
  let section = null;
  let seenToolBlock = false;
  for (const raw of TOOL_USAGE_MANUAL.split(/\n{2,}/)) {
    const text = raw.trim();
    if (!text) continue;
    const header = text.split('\n')[0];
    // Un identifiant d'outil contient presque toujours un underscore
    // (`get_tweet`, `ban_user`…), ce qu'aucun mot de prose française ne fait :
    // sa présence identifie un en-tête d'outil. Dans un tel en-tête, tous les
    // mots en minuscules sont alors des noms d'outils — c'est ce qui rattrape
    // le seul nom sans underscore (`remember`). Les mots parasites d'un
    // en-tête mixte (« casino actuel: … ») ne correspondent à aucun outil
    // enregistré, donc ne sélectionnent jamais rien.
    const underscored = header.match(/[a-z][a-z0-9_]*_[a-z0-9_]+/g) || [];
    const tools = underscored.length ? (header.match(/[a-z][a-z0-9_]{2,}/g) || []) : [];
    if (!tools.length) {
      // En-tête de prose : préambule du manuel (avant tout bloc d'outil) ou
      // préface d'une famille d'outils (« OUTILS D'ADMINISTRATION… »).
      if (seenToolBlock) section = { header, text };
      blocks.push({ header, text, tools: [], section: null, general: true, preamble: !seenToolBlock });
      continue;
    }
    seenToolBlock = true;
    blocks.push({ header, text, tools, section, general: false, preamble: false });
  }
  return blocks;
})();

/** Noyau toujours présent dans le prompt : titre + règle générale (~800 caractères). */
const MANUAL_CORE = MANUAL_BLOCKS.filter(block => block.preamble).map(block => block.text).join('\n\n');

/**
 * Recettes d'usage des outils demandés, avec le préambule de leur section
 * quand il y en a un (les outils d'administration héritent ainsi de leur
 * avertissement commun).
 *
 * @param {string[]} names noms d'outils
 * @returns {string} '' si aucun bloc ne concerne ces outils
 */
function manualFor(names) {
  const wanted = new Set((Array.isArray(names) ? names : [names]).filter(Boolean));
  if (!wanted.size) return '';
  const parts = [];
  const seenSections = new Set();
  for (const block of MANUAL_BLOCKS) {
    if (block.general || !block.tools.some(tool => wanted.has(tool))) continue;
    if (block.section && !seenSections.has(block.section.header)) {
      seenSections.add(block.section.header);
      parts.push(block.section.text);
    }
    parts.push(block.text);
  }
  return parts.join('\n\n');
}

/** Recettes d'un seul outil (alias historique de `manualFor`). */
function manualForTool(name) {
  return manualFor([name]);
}

module.exports = { TOOL_USAGE_MANUAL, MANUAL_CORE, MANUAL_BLOCKS, manualFor, manualForTool };
