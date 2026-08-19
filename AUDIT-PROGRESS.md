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
| B1 | Robustesse | Verrous et concurrence | **TERMINÉE** | `AUDIT-B1.md` |
| B2 | Robustesse | Erreurs et journaux | **TERMINÉE** | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | **TERMINÉE** | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | **TERMINÉE** | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | **EN COURS** | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** S3 — injection, validation, abus. **PARTIELLE, 2
  constats, dont 1 CRITIQUE.**
- **Couvert :** R1 (10), R2 (12), R3 (11), R4 (9), B1 (8), B2 (9), S1 (4),
  **S2 (6, dont 1 CRITIQUE et 3 ÉLEVÉS)** — **R1 à S2 TERMINÉES**. S3 en cours.

- **S2 est TERMINÉE.** 6 constats, récapitulatif écrit dans `AUDIT-S2.md` et
  ici. Ne rien y reprendre. Résumé pour mémoire (détail complet plus haut dans
  l'historique de ce fichier / dans les commits de la section S2) :
  3 constats dans `userSimilarityRoutes.js` (`authenticateToken` importé,
  jamais utilisé) ; IDOR généralisé sur les 19 routes d'`advancedAdRoutes.js`
  (aucune ne vérifie l'appartenance de la publicité/campagne/test A/B) ;
  élévation de privilèges critique dans `moderationController.js:2873`
  `promoteModerator` (aucune comparaison au rôle de l'appelant, un
  détenteur de `can_manage_moderators` peut s'auto-promouvoir `superadmin`) ;
  fuite d'IP/user-agent de l'auteur dans le fil de tweets (`Tweet.metadata`
  non filtré par `toJSON()`).

- **S3 — CONSTAT CRITIQUE, déjà écrit, NE PAS REFAIRE :** `src/economy/ledger.js:152`
  `mintFromPurchase`, appelé par `POST /api/new-economy/purchase`
  (`newEconomyRoutes.js:28` → `newEconomyController.js:53` `purchaseCoins` →
  `newEconomyService.js:121` `purchaseCoins`). Le client envoie `currencyId`,
  `packageId` (parmi une liste fermée de forfaits, donc le **prix** est
  résolu côté serveur via `PURCHASE_PACKAGES.find(...)` — ce n'est PAS le
  défaut) et `paymentMethod` (une simple chaîne parmi
  `['stripe','paypal','apple_pay','google_pay']`, jamais vérifiée). Recherche
  effectuée sur l'ensemble de `src/` et de `package.json` :
  `grep -rln "stripe|verifyReceipt|apple.*receipt|google.*receipt|IN_APP|iap" src/`
  → un seul résultat pertinent, l'énumération de validation de
  `newEconomyRoutes.js` elle-même (l'autre résultat, `profileCustomization.js`,
  est un style CSS "stripes" sans rapport) ; `grep -iE "stripe|paypal|braintree" package.json`
  → **aucune dépendance de paiement installée**. La seule protection en amont
  est `transactionAuthorizationService.authorize` (`transactionAuthorizationService.js:869`),
  qui appelle un moteur de score de risque comportemental externe (Rust —
  vélocité, empreinte device/IP) : **il évalue si la transaction est
  suspecte, il ne vérifie à aucun moment qu'un paiement a eu lieu.**
  Conséquence : sauf vérification hors dépôt d'un webhook de paiement externe
  (à demander explicitement au propriétaire — improbable vu l'absence totale
  de SDK, mais pas formellement exclu depuis le code seul), **n'importe quel
  compte authentifié peut créditer son portefeuille en monnaie réelle de la
  plateforme en appelant cette route, sans jamais payer**, à la cadence
  permise par le débit (voir constat suivant). Correctif à transmettre :
  vérification serveur du paiement avant `mintFromPurchase` — reçu Apple/Google
  vérifié auprès des serveurs d'Apple/Google, `payment_intent` Stripe/PayPal
  confirmé côté serveur via webhook signé — et non une simple valeur déclarée
  par le client.

- **S3 — CONSTAT MOYEN, déjà écrit, NE PAS REFAIRE :** `isTrustedFirstPartyClient`
  (`src/middleware/fraudMiddleware.js:196`) repose sur cinq en-têtes HTTP
  ordinaires et un JWT valide — **aucune signature, aucune attestation
  cryptographique, aucun secret partagé.** Détail des fonctions vérifiées :
  `hasWindowsElectronTransport` (`:166`) teste `user-agent` (doit contenir
  `twitninf-windows`), `user-platform` (`windows`), `x-app-ownership`
  (`standalone`), `x-twitninf-client` (`windows-electron`) — quatre en-têtes,
  tous lisibles et falsifiables par n'importe quel client HTTP.
  `hasMobileAppTransport` (`:183`) teste `user-platform`, `x-twitninf-client`,
  `x-device-id` (juste une longueur ≥ 8) — même défaut. `getVerifiedBearerUserId`
  (`:152`) exige un JWT valide, mais **n'importe quel compte inscrit en obtient
  un** via `/register` + `/login` (routes publiques, `authRoutes.js`). Donc
  un simple script peut se faire passer pour l'app officielle avec cinq
  valeurs d'en-tête connues et un compte gratuit. Ce mécanisme conditionne
  **quatre exemptions de limite de débit**, toutes vérifiées :
  `server.js:279` (limiteur global, 1000/15 min), `server.js:323`
  (`tweetLimiter`, 200 tweets/15 min), `server.js:337` (`searchLimiter`,
  300/15 min), et `authMiddleware.js:280` (`userRateLimit`, générique,
  utilisé ailleurs dans le dépôt). **Le point important pour la gravité :**
  ce mécanisme n'a **pas** de limiteur dédié sur `/api/new-economy/purchase` —
  seul le minage en a un (`server.js:298`) — donc `/purchase` ne dépend que du
  quota global de `:279`, lui-même désactivable par la usurpation ci-dessus.
  **Combiné au constat critique**, cela signifie qu'un attaquant qui usurpe le
  statut first-party peut appeler `/purchase` sans aucune limite HTTP,
  l'unique filet restant étant le moteur de risque Rust externe — dont on a vu
  en B2-03 que ses verdicts en mode surveillance ne sont pas garantis
  persistés. Les commentaires du code montrent que ce choix est **délibéré**
  (le trafic first-party est « laissé au moteur anti-fraude... vélocité API
  dédiée ») — ce n'est donc pas un oubli, mais l'hypothèse implicite que
  seule l'app officielle peut produire ces en-têtes est fausse. Correctif à
  transmettre : lier le statut first-party à une preuve cryptographique
  (attestation d'app mobile de la plateforme — App Attest / Play Integrity —
  ou un secret d'app signé et à rotation), pas à des en-têtes déclaratifs ; à
  défaut, poser un plancher de débit même pour le trafic first-party sur les
  routes créditrices.

- **S3 — reprendre à :** le reste du périmètre n'a **pas encore été couvert** :
  1. **SQL par concaténation**, en particulier un **nom de colonne** venant
     d'une entrée utilisateur (tri/filtre paramétrable) — précédent connu sur
     ce dépôt d'après la consigne d'audit. Chercher les tris/filtres
     dynamiques dans `src/routes/` (`sort=`, `order_by=`, `?sort=`) et
     vérifier comment le nom de colonne est validé avant d'atteindre
     Sequelize (`literal`, `col`, `order: [[...]]` avec une valeur non
     contrôlée par liste blanche).
  2. Validation absente sur les routes d'écriture — parcours par échantillonnage
     des routes `POST`/`PUT`/`PATCH` sans tableau `express-validator`.
  3. Upload : type réel du fichier (pas seulement l'en-tête `Content-Type`
     déclaré par le client), taille, construction du chemin de destination
     (traversée de répertoire).
  4. Limitation de débit sur mot de passe oublié — **déjà partiellement
     couvert par B2-07** (la route ne fonctionne pas du tout, donc la
     question du débit y est seconde) ; vérifier si un compte peut être
     harcelé de jetons de réinitialisation malgré tout (chaque appel écrase
     le précédent, donc l'impact est probablement faible — à confirmer).
  5. Rejeu d'opération créditrice — au-delà du constat déjà écrit sur
     `/purchase`, vérifier `/exchange` et `/transfer` (`newEconomyRoutes.js:102`,
     `:107`) pour une éventuelle absence d'idempotence (un même appel
     rejoué deux fois, ex. par un retry client, double-crédite-t-il ?).
  6. La fenêtre de 15 secondes de `transaction_risk_authorizations`
     (constat B1-02) : une autorisation validée survit à l'annulation de la
     transaction qui l'a demandée — vérifier si elle est réutilisable pour
     une opération différente de celle qui l'a obtenue.
  7. `src/routes/messageRoutes.js:59` (`requireGroupManagementRights` évalué
     hors transaction — constat B1-04, déjà documenté comme défaut de
     concurrence ; vérifier ici s'il ouvre aussi une fenêtre d'abus côté
     validation/autorisation plutôt que seulement de robustesse).

- **Reste :** S3 (en cours, partielle).

## Règles de la routine

- ⚠️ **`.gitignore` ligne 30 contient `*.md`.** Un nouveau fichier
  `AUDIT-<CODE>.md` n'est **pas** suivi par `git add -A` : il faut
  `git add -f AUDIT-<CODE>.md` **la première fois**. Une passe a écrit R3, R4 et
  B1 entièrement sans que rien ne parte au dépôt, et ne s'en est aperçue qu'à la
  fin. **Après le premier commit d'une section, vérifier :**
  `git ls-files | grep AUDIT` doit lister le nouveau fichier.
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
