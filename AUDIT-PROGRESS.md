# Audit approfondi — twitninf-api

Suivi d'avancement. Une routine périodique traite **une section à la fois**,
par ordre de priorité impératif : **1) RAPIDITÉ, 2) ROBUSTESSE, 3) SÉCURITÉ**.

> Ce dépôt est **public**. Les sections `S*` ne publient ici que le **décompte et
> la gravité** des constats. Aucun secret, aucun chemin exact, aucune méthode
> d'exploitation n'est écrit dans les fichiers poussés : le détail est transmis
> au propriétaire uniquement.

## Sections

| Code | Priorité | Sujet | État | Rapport |
|------|----------|-------|------|---------|
| R1 | Rapidité | Requêtes N+1 | **TERMINÉE** | `AUDIT-R1.md` |
| R2 | Rapidité | Index et requêtes lentes | **TERMINÉE** | `AUDIT-R2.md` |
| R3 | Rapidité | Pagination et taille des réponses | **TERMINÉE** | `AUDIT-R3.md` |
| R4 | Rapidité | Travail bloquant (boucle d'événements) | **TERMINÉE** | `AUDIT-R4.md` |
| B1 | Robustesse | Verrous et concurrence | **EN COURS** | `AUDIT-B1.md` |
| B2 | Robustesse | Erreurs et journaux | À FAIRE | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | À FAIRE | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** B1 — verrous et concurrence.
- **Couvert :** R1 (10 constats), R2 (12), R3 (11), R4 (9) — **R1 à R4
  TERMINÉES**, chacune avec sa section « vérifié et trouvé sain » et son
  récapitulatif.
- **Couvert pour B1 :** 1 constat écrit (B1-01, `src/economy/metrics.js:100`
  `EconomyMetrics.refresh` — verrou de ligne global sur la monnaie, `SUM` de
  toute la table des portefeuilles sous ce verrou, et `purchaseVolume24h`
  (`:81`) qui emprunte une **seconde** connexion hors transaction → risque
  d'interblocage sur le pool ; 20 appelants recensés).
- **Reprendre à :** inventaire des 76 `sequelize.transaction(` de `src/`.
  Déjà vérifié SAIN : `newEconomyService.js:371` `submitMiningProof` (verrou
  sur la ligne du round, pas sur `users` — bonne granularité).
  À regarder ensuite, dans l'ordre : `usernameMarketService.js:205/255/348/378`
  (plusieurs verrous `users` dans la même transaction → **ordre de
  verrouillage** à vérifier), `communityModerationService.js` (7 `FOR UPDATE`),
  `casinoService.js:242`, `transactionAuthorizationService.js`,
  `paidContentService.js`, `gAuthService.js:317`,
  `policiercongo/policiercongov3/platformTools.js:705`,
  `customTweetGenerationService.js:96`, `BotDetectionService.js:254`,
  `tweetEditService.js:114`, `virtualCurrencyController.js:562`.
  Puis chercher : appel réseau (`fetch`/`axios`) **à l'intérieur** d'une
  transaction, et boucles englobées par une transaction.

- **Pistes déjà repérées pour B1, à vérifier en premier :**
  - `src/routes/messageRoutes.js:489` (`findExactDirectConversation`) : lecture
    **non bornée de toute la table `conversations`** exécutée **à l'intérieur**
    de la transaction ouverte par `POST /api/messages/direct/:userId`
    (`:596`, `tx`). Forme exacte du précédent connu. Voir R3-02.
  - `src/models/User.js:648-663` : les hooks `beforeCreate`/`beforeUpdate`
    hachent le mot de passe (~335 ms mesurés, cf. R4-02) — vérifier s'ils
    s'exécutent dans une transaction d'inscription.
  - Chercher : `sequelize.transaction(` suivi d'un `await fetch`/`axios`
    (appel réseau sous verrou), `lock:`/`FOR UPDATE`, et les transactions qui
    englobent une boucle.
  - `src/services/transactionAuthorizationService.js` (1 405 lignes) et
    `src/economy/` : logique d'économie, donc verrous probables.

- **PISTE POUR B2 :** `similarity/recommendationEngine.js:711` crée un
  `new Float32Array(256)` alors que `DIMS = 768` (`vectorEngine.js:26`) ; le
  commentaire « DIMS = 256 » est périmé. `VectorStore.upsert` (`:311`) refuse
  donc le vecteur et émet un `console.warn` **par tweet vidéo/média sans
  texte**, à chaque reconstruction. Double conséquence : bruit massif dans les
  journaux (le symptôme « un millier de fausses erreurs » décrit dans la
  consigne) **et** ces tweets ne sont jamais vectorisés — bug fonctionnel
  silencieux. À rédiger en B2.
- **PISTE POUR B2 :** `src/services/verificationService.js:385` écrit un fichier
  `temp/verification-prompt-<horodatage>.txt` à chaque vérification, jamais
  supprimé.
- **PISTE POUR S3 (ne pas publier le détail) :** `src/server.js:279`, la
  fonction `skip` du limiteur de débit global.
- **PISTE POUR S2 (ne pas publier le détail) :** `src/models/Tweet.js:498`,
  valeur par défaut de la colonne `metadata`, croisée avec l'absence de liste
  blanche de sortie dans le fil (`src/routes/tweetRoutes.js:568`).

- **Reste :** B1 (en cours), B2, S1, S2, S3.

## Règles de la routine

- Traiter la **première section À FAIRE / EN COURS**, et elle seule.
- **Un commit et un push par constat** — pas par section. On écrit le constat
  dans `AUDIT-<CODE>.md`, on met à jour « REPRENDRE À » ci-dessus, on pousse,
  et seulement ensuite on cherche le constat suivant.
- La section en cours est marquée `EN COURS`, jamais `À FAIRE`.
- À la fin d'une section : passer sa ligne à `TERMINÉE` et pousser.
- Ne jamais pousser sur la branche par défaut. Aucune pull request.
- Aucun fichier source n'est modifié : on observe et on rapporte.
- Quand tout est TERMINÉ : écrire `AUDIT TERMINÉ` en première ligne de ce
  fichier et signaler que la routine peut être désactivée.
