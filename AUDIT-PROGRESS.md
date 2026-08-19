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
- **Couvert pour B1 :** 4 constats écrits (B1-01, `src/economy/metrics.js:100`
  `EconomyMetrics.refresh` — verrou de ligne global sur la monnaie, `SUM` de
  toute la table des portefeuilles sous ce verrou, et `purchaseVolume24h`
  (`:81`) qui emprunte une **seconde** connexion hors transaction → risque
  d'interblocage sur le pool ; 20 appelants recensés ;
  B1-02 `transactionAuthorizationService.js:318` `_claimAuthorization` +
  `:409` `_recordReplayMismatch` écrivent hors de la transaction de l'appelant,
  avec `DB_POOL_MAX=10` et `acquire=60000` — incident déjà survenu, documenté
  dans `usernameMarketService.js:358-372` ;
  B1-03 `messageRoutes.js:597` `POST /messages/direct/:userId` — `:624` et
  `:658` appellent des contrôles d'accès qui font jusqu'à 6 requêtes **hors**
  de `tx`, dont 2 en `Promise.all` → pic de 3 connexions par requête, 4 requêtes
  simultanées suffisent à vider un pool de 10 ;
  B1-04 `messageRoutes.js:958/1219/1353/1388` — `requireMembership` (`:53`) et
  `requireGroupManagementRights` (`:59`) n'acceptent pas de transaction ; le
  second est un **contrôle d'accès lu hors transaction**, à reprendre en S2).
- **Reprendre à :** inventaire des 76 `sequelize.transaction(` de `src/`.
  Déjà vérifié SAIN : `newEconomyService.js:371` `submitMiningProof` (verrou
  sur la ligne du round, pas sur `users` — bonne granularité) ;
  `usernameMarketService.js:374` `buyListing` (verrous pris dans un **ordre
  déterministe par id**, `NO KEY UPDATE` justifié en commentaire — exemplaire) ;
  `economy/ledger.js:155/395/687` (`authorize` appelé **avant** `lockWallet`,
  donc aucun verrou tenu pendant l'autorisation ; exemption
  `INTERNAL_CONVERSION_EXEMPTION` documentée à `:684`).
  À regarder ensuite, dans l'ordre : `communityModerationService.js`
  (7 `FOR UPDATE`), `casinoService.js:242`, `paidContentService.js`,
  `gAuthService.js:317`,
  `policiercongo/policiercongov3/platformTools.js:705`,
  `customTweetGenerationService.js:96`, `BotDetectionService.js:254`,
  `tweetEditService.js:114`, `virtualCurrencyController.js:562`.
  **Vérifié SAIN :** aucun appel réseau (`fetch`/`axios`) trouvé à l'intérieur
  d'une transaction — balayage automatisé des deux formes (`transaction(async`
  et `const tx = await sequelize.transaction()`), aucun résultat. Les émissions
  Socket.io de `messageRoutes.js` sont bien **après** `commit`.
  **Balayage exhaustif FAIT** (les deux formes de transaction, tout `src/`) :
  0 appel de modèle sans `transaction:` dans un bloc transactionnel ;
  6 appels de fonctions touchant la base sans recevoir `tx`, **tous dans
  `messageRoutes.js`** — couverts par B1-03 (`:624`, `:658`) et B1-04 (`:958`,
  `:1219`, `:1353`, `:1388`). Réserve : le balayage ne suit pas les appels
  indirects ni ceux traversant un module (B1-01 et B1-02 sont de cette forme et
  ont été trouvés à la lecture).
  **Reste à faire pour clore B1 :** (i) transactions englobant une **boucle**
  (chercher `for`/`while`/`map` entre `transaction()` et `commit()`) ;
  (ii) `communityModerationService.js` (7 `FOR UPDATE`), `casinoService.js:208`,
  `paidContentService.js`, `gAuthService.js:317`,

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
