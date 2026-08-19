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

- **Section en cours :** S3 — injection, validation, abus. **PARTIELLE, 4
  constats, dont 2 CRITIQUES.**
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

- **S3 — CONSTAT MOYEN, déjà écrit, NE PAS REFAIRE : `src/services/videoService.js`,
  upload vidéo — fichier temporaire jamais purgé sur échec de sondage.**
  `multer.diskStorage` (`:25-33`) écrit le fichier reçu dans `TEMP_DIR`
  (jusqu'à 500 Mo, `limits.fileSize`, `:49`) sous un nom composé de
  `'temp_video_' + Date.now() + '-' + random + path.extname(file.originalname)`
  — **l'extension vient telle quelle du nom de fichier fourni par le
  client, sans liste blanche.** Vérifié que `path.extname` ne permet pas de
  traversée de répertoire (testé : un `originalname` avec des `../` ne fait
  remonter que le dernier segment, jamais un chemin), donc ce point précis
  n'ouvre pas de traversée de fichier ; en revanche l'extension peut contenir
  n'importe quel caractère (testé : `.mp4;rm -rf` est un extname valide en
  JS). **Vérifié que ceci n'est PAS exploitable en injection de commande** :
  `fluent-ffmpeg` (`ffmpeg.ffprobe`, `:88`, et `ffmpeg(inputPath)`, `:103`)
  invoque le binaire via un `spawn` à arguments tableau, pas une chaîne de
  commande shell ; et le nettoyage (`fs.unlink`, `:167` et `:201`) utilise
  directement l'API `fs`, jamais un shell. **Le vrai défaut, confirmé :**
  quand `ffmpeg.ffprobe(inputPath, ...)` échoue (`:89-92`, ex. un fichier qui
  passe le `fileFilter` — `mimetype.startsWith('video/')`, entièrement
  déclaratif côté client, `videoService.js:37-44` — mais n'est pas un vrai
  flux vidéo décodable), la promesse est rejetée **sans jamais supprimer
  `inputPath`**. Le seul `fs.unlink` du fichier d'origine est dans le
  callback `.on('end')` de la miniature (`:167`), une branche de succès
  jamais atteinte sur cet échec. Remonté jusqu'à la route
  (`tweetRoutes.js:1888-1897`), le `catch` du traitement en arrière-plan
  journalise et marque le tweet `rejected`, **sans jamais appeler
  `fs.unlink`** non plus ; le `catch` externe de la route porte même le
  commentaire `// Cleanup if possible? Usually handled in service.` — un
  aveu d'incertitude de l'auteur original, et la vérification confirme que
  non, ce n'est pas géré. **Effet :** un compte authentifié peut envoyer en
  boucle des fichiers jusqu'à 500 Mo avec un `Content-Type: video/*` usurpé
  mais un contenu non décodable, et chaque envoi laisse un fichier orphelin
  définitif dans `TEMP_DIR` — remplissage de disque, sans purge, sans
  authentification renforcée, sans limite de débit dédiée à cette route.
  **Combiné au constat S3 précédent** (usurpation first-party), l'ampleur
  n'est bornée par aucune limite HTTP. Correctif à transmettre :
  `fs.unlink(inputPath, () => {})` dans le `catch` de `ffprobe` et dans le
  `catch` du traitement en arrière-plan de la route ; liste blanche
  d'extensions acceptées (`.mp4`, `.mov`, `.webm`, `.m4v`) avant l'écriture
  disque plutôt qu'après ; envisager une tâche de purge périodique de
  `TEMP_DIR` par âge, en filet de sécurité.
  **NE PAS refaire cette recherche.**

- **S3 — CONSTAT CRITIQUE (2/2), déjà écrit, NE PAS REFAIRE :
  `src/routes/userChallengeRoutes.js:119` `PUT /:challengeId/progress` —
  progression de défi entièrement forgeable, chaîne complète jusqu'au vol
  d'une récompense exclusive à stock limité.** Chaîne vérifiée de bout en
  bout, chaque maillon lu dans le code :
  1. `userChallengeRoutes.js:119-149` : route accepte `{ event_slug, progress }`
     du corps de la requête, seul contrôle `if (!event_slug || progress === undefined)`
     — aucune borne, aucun type imposé. Appelle
     `UserChallenge.updateChallengeProgress(userId, challengeId, event_slug, progress)`
     (`userId` = `req.user.id`, donc l'attaque ne porte que sur les propres
     défis de l'appelant — pas un IDOR sur autrui, mais un vol de récompense
     par soi-même).
  2. `src/models/UserChallenge.js:150-157` `updateChallengeProgress` charge
     le défi (`getUserChallenge`, filtré `user_id: userId` — sain sur ce
     point) puis appelle `challenge.updateProgress(progress)` **sans aucune
     dérivation depuis une activité réelle**.
  3. `UserChallenge.js:88-92` `prototype.updateProgress` :
     `this.progress = Math.min(newProgress, this.max_progress);
     this.completed = this.progress >= this.max_progress; return this.save();`
     — le `Math.min` empêche seulement de dépasser le maximum, **pas** d'y
     accéder directement en un seul appel avec une valeur absurdement grande
     (`progress: 999999999`). Un seul appel marque n'importe quel défi
     `completed: true`.
  4. `POST /:challengeId/claim` (`userChallengeRoutes.js:157`) →
     `UserChallenge.claimChallengeReward` (`:159-165`) →
     `prototype.claimReward` (`UserChallenge.js:94-100`) : ne vérifie que
     `this.completed && !this.claimed` — la seule condition étant celle
     forgée à l'étape 3, elle passe, et `claimed = true` est posé.
  5. `POST /claim-special-reward/:eventSlug`
     (`userChallengeRoutes.js:406-432`, restreint à
     `eventSlug === 'kosporbirthday'`) → `UserChallenge.claimSpecialReward`
     (`UserChallenge.js:172-220`) : vérifie
     `challenges.every(c => c.completed && c.claimed)` sur **les mêmes
     lignes forgées aux étapes 3-4**, vérifie l'absence de doublon et le
     stock restant (ces deux derniers contrôles sont sains), puis appelle
     `VerificationStyleService.addRoseItemToInventory(userId)` — attribution
     réelle d'un objet d'inventaire exclusif, à stock limité
     (`checkRoseItemStock`), à un compte qui n'a satisfait aucune condition
     réelle. **C'est l'impact concret et vérifié : un objet à stock limité
     peut être obtenu sans la moindre activité authentique**, en trois appels
     HTTP scriptables (`PUT progress` × N défis, `POST claim` × N,
     `POST claim-special-reward`).
  **Note :** la stat `total_rewards: ... * 5` vue dans `GET /stats/:eventSlug`
  (`:196`) est purement un affichage calculé à la volée, **pas** un crédit de
  monnaie réel déclenché par `claimReward` — vérifié qu'aucun appel à un
  service de monnaie/portefeuille n'existe dans `UserChallenge.js`. L'impact
  économique direct de CE constat est donc l'objet exclusif, pas un mint de
  TWC. **Vérifié :** les routes spécifiques voisines
  (`update-likes-progress/:eventSlug`, `update-tweets-progress/:eventSlug`,
  `challengeProgressService.js:37+`) ne prennent **aucune valeur du client** —
  seuls `userId` et `eventSlug` en entrée, la progression est recalculée par
  une requête SQL sur les vraies données (ex. `COUNT(*) FROM tweet_likes ...
  WHERE t.user_id = :userId`). **Ces routes-là sont saines.** Le défaut est
  donc localisé à la seule route générique `PUT /:challengeId/progress`, qui
  fait doublon avec elles sans en avoir les garde-fous — sa suppression pure
  et simple est probablement le correctif le plus sûr.
  Correctif à transmettre : ne jamais accepter `progress` brut du client sur
  cette route ; soit la retirer complètement au profit des routes
  spécifiques qui recalculent depuis l'activité réelle
  (`update-likes-progress`, `update-tweets-progress`, etc. — à vérifier
  qu'elles le font bien, non encore fait), soit la limiter à une incrémentation
  serveur bornée par événement réel plutôt qu'une valeur absolue envoyée par
  le client.
  **NE PAS refaire cette recherche.**

- **S3 — vérifié et SAIN (ne pas réexaminer) :**
  1. **SQL par concaténation / colonne pilotée par le client.** Recherché
     `sequelize.literal`/`sequelize.query` avec interpolation `${...}` dans
     tout `src/` (78 sites recensés). Tous les sites de tri paramétrable
     trouvés (`usernameMarketService.js:541-544`,
     `advancedSearch.js:231-238`) résolvent le nom de colonne réel via une
     correspondance fixe (ternaire ou objet `sortMap`), jamais par
     concaténation directe de l'entrée client — c'est un motif sûr même
     quand la clé de recherche est arbitraire, puisque seule la VALEUR
     whitelistée ressort. Le seul point qui restait à risque,
     `advancedSearch.js:238` (`direction.toUpperCase()` concaténé sans
     passer par `sortMap`), est protégé en amont par
     `ADVANCED_SEARCH_SCHEMA.sort.direction: { enum: ['asc','desc'] }`
     (`advancedSearch.js:72`), et j'ai vérifié que `toolRegistry.js:189-191`
     bloque bien l'exécution de l'outil si la validation de schéma échoue
     (`if (errors.length) return this.result(...)`, avant tout appel au
     handler). Aucun site exploitable trouvé. `raidBotService.js` (colonnes
     SQL interpolées) vérifié séparément : toutes les valeurs interpolées
     (`shownCount('followers')`, etc.) sont des littéraux fixes appelés avec
     des clés en dur dans le code, jamais depuis `req.query`/`req.body`
     (aucune occurrence de ces deux dans le fichier). `tweetQueueService.js`
     (`:391`, `:455`, `:490`) : colonnes choisies via `columnMap`/`.has()`
     sur liste fermée, avec un commentaire du code montrant une conscience
     explicite du risque.
  2. **Upload d'image** (avatar, bannière, image de tweet — `userRoutes.js:1359`,
     `tweetRoutes.js:39`). Le filtre `fileFilter` ne teste que le
     `mimetype` déclaré (donc contournable), MAIS chaque fichier est ensuite
     passé à `sharp()` avant d'être écrit sur disque
     (`userRoutes.js:1391-1395`, `tweetImageService.js:76`), avec un nom de
     fichier **entièrement généré côté serveur**
     (`${userId}-${Date.now()}-${uuid}.jpg`, jamais dérivé du nom fourni par
     le client — donc aucune traversée de chemin possible ici, à la
     différence de l'upload vidéo). `sharp` échoue sur tout contenu qui
     n'est pas une image réellement décodable, ce qui constitue une
     validation de fait du contenu, et son export force le format de sortie
     (toujours `.jpeg(...)`), ce qui élimine tout contenu actif qu'un format
     image détourné (SVG avec script, par exemple) pourrait porter. Sain.

- **S3 — reprendre à :** le reste du périmètre n'a **pas encore été couvert** :
  1. Validation absente sur les routes d'écriture — un balayage automatisé
     naïf (chercher `body(`/`param(`/`query(` dans les 10 lignes suivant
     chaque route `POST`/`PUT`/`PATCH`) a renvoyé **156 routes sans validateur
     visible dans `src/routes/`** — mais ce chiffre est un plafond brut, pas
     un décompte de constats : par analogie avec le faux-positif de S2 (74 →
     52 après prise en compte des alias), une bonne partie de ces 156 valide
     probablement en dehors de la fenêtre de recherche (dans le contrôleur,
     via un tableau de règles nommé importé, etc.). **Ne pas répéter le
     balayage brut** — la liste des 156 candidats est reproductible avec le
     script Python déjà utilisé (recherche `router\.(post|put|patch)` sans
     `body(|param(|query(|express-validator|handleValidationErrors|validationResult`
     dans les 10 lignes suivantes). Prochain pas : trier ces 156 par
     fichier, écarter les faux positifs (validation dans le contrôleur ou via
     un tableau nommé), puis évaluer les survivants un par un en priorisant
     les routes qui touchent de l'argent ou des données sensibles
     (`adRoutes.js`, `economyAdminRoutes.js`, `eventPassRoutes.js`,
     `featureFlagRoutes.js` ont le plus de candidats bruts).
  2. Limitation de débit sur mot de passe oublié — **déjà partiellement
     couvert par B2-07** (la route ne fonctionne pas du tout, donc la
     question du débit y est seconde) ; vérifier si un compte peut être
     harcelé de jetons de réinitialisation malgré tout (chaque appel écrase
     le précédent, donc l'impact est probablement faible — à confirmer).
  3. Rejeu d'opération créditrice — au-delà du constat déjà écrit sur
     `/purchase`, vérifier `/exchange` et `/transfer` (`newEconomyRoutes.js:102`,
     `:107`) pour une éventuelle absence d'idempotence (un même appel
     rejoué deux fois, ex. par un retry client, double-crédite-t-il ?).
     **Piste déjà écartée pour `/campaigns/:id/fund` et `/advertisements/:id/fund`**
     (`adRoutes.js:650`, `:713`) : vérifié que `debitTWC` délègue à
     `NewEconomyService.spendCoins` → `EconomyLedger.spendToTreasury`, qui
     suit le même schéma de verrouillage de portefeuille que
     `mintFromPurchase` (déjà vérifié sain sur ce point précis en B1) — la
     vérification de solde dans la route elle-même est redondante mais
     inoffensive, l'enforcement réel est dans le ledger verrouillé.
  4. La fenêtre de 15 secondes de `transaction_risk_authorizations`
     (constat B1-02) : une autorisation validée survit à l'annulation de la
     transaction qui l'a demandée — vérifier si elle est réutilisable pour
     une opération différente de celle qui l'a obtenue.
  5. `src/routes/messageRoutes.js:59` (`requireGroupManagementRights` évalué
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
