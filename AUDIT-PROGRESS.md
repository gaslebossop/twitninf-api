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
| S2 | Sécurité | Autorisation et IDOR | **TERMINÉE (+1 constat ajouté après coup)** | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | **EN COURS** | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** S3 — injection, validation, abus. **PARTIELLE, 15
  constats, dont 8 CRITIQUES, 2 ÉLEVÉS et 5 MOYENS.**
- **Couvert :** R1 (10), R2 (12), R3 (11), R4 (9), B1 (8), B2 (9), S1 (4),
  **S2 (6, dont 1 CRITIQUE et 3 ÉLEVÉS)** — **R1 à S2 TERMINÉES**. S3 en cours.

- **S2 — CONSTAT CRITIQUE AJOUTÉ APRÈS CLÔTURE, déjà écrit, NE PAS REFAIRE :
  `userRoutes.js`, quatre routes de modération de compte
  (`POST /:id/suspend`, `/:id/unsuspend`, `/:id/ban`, `/:id/unban`,
  toutes autour de `userRoutes.js:1518-1652`).** Trouvé en examinant ce
  fichier sous l'angle S3 (validation), mais c'est un constat S2 pur
  (contrôle de rôle absent), ajouté dans `AUDIT-S2.md` plutôt qu'ici pour
  le décompte public — voir ce fichier pour le décompte. Chaîne vérifiée :
  la chaîne de middleware de ces quatre routes est
  `[authenticateToken, checkUserBanStrict, param('id').isUUID(),
  handleValidationErrors]` — confirmé en lisant `checkUserBanStrict`
  (`banMiddleware.js:71`) que cette fonction vérifie uniquement que
  **l'appelant lui-même** n'est pas suspendu/banni, rien sur son rôle.
  `requireAdmin` n'est **jamais importé** dans `userRoutes.js` (recherche
  confirmée : `grep -n "requireAdmin" src/routes/userRoutes.js` → aucun
  résultat), et il n'existe aucun `router.use(...)` de portée globale sur
  ce fichier qui imposerait un rôle. Le service appelé
  (`BanService.suspendUser`/`unsuspendUser`/`addBan`/`reduceBan`,
  `banService.js:18+`) prend bien un paramètre `adminId`, mais **ne le
  vérifie jamais** — il ne sert qu'à l'enregistrer dans les métadonnées
  d'audit. `server.js` monte `userRoutes` sans middleware englobant
  (`app.use('/api/users', userRoutes)`, aucun rôle imposé à ce niveau non
  plus). **Confirmé par contraste** avec le constat déjà écrit dans
  `AUDIT-S2.md` (« Routeur de modération... le mieux protégé du dépôt,
  chaque route sensible porte une permission nommée précise ») : il existe
  donc, ailleurs dans le dépôt, un routeur de modération distinct qui fait
  ce contrôle correctement pour les mêmes actions — ces quatre routes-ci
  sont un second chemin, non gardé, vers les mêmes effets. **Impact : tout
  compte authentifié et non suspendu peut suspendre, lever la suspension,
  bannir ou débannir n'importe quel autre compte de la plateforme — y
  compris un modérateur ou un administrateur — sans aucune vérification de
  rôle, en un seul appel HTTP par action.** Correctif à transmettre :
  ajouter le même contrôle de permission nommé que le routeur de
  modération correct (`can_suspend_users`, `can_ban_users`) à ces quatre
  routes, ou les supprimer au profit du routeur qui fait déjà ce contrôle
  correctement. **NE PAS refaire cette recherche.**

- **S2 était TERMINÉE avant l'ajout ci-dessus.** 6 constats initiaux,
  récapitulatif écrit dans `AUDIT-S2.md` et
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

- **S3 — CONSTAT ÉLEVÉ (validation absente), déjà écrit, NE PAS REFAIRE :
  `src/routes/economyAdminRoutes.js:33` `PUT /wallets/balance` →
  `economyAdminController.js:276` `updateWalletBalance` →
  `src/economy/ledger.js:598` `adminAdjustBalance`.** Route admin, protégée
  par `authenticateToken` + `requireEconomyRole` (rôles `moderateur`,
  `economiegardien`, `admin`, `superadmin` — donc pas ouverte à n'importe
  qui, mais accessible à un rôle relativement répandu, `moderateur`).
  Le contrôleur (`:276-301`) lit `{ userId, amount, reason }` du corps
  **sans aucune validation de présence ni de type** et passe `amount`
  directement comme `delta` à `adminAdjustBalance`. Chaîne vérifiée :
  `adminAdjustBalance` (`ledger.js:598-606`) calcule
  `target = roundTWC(current + Number(delta))`. Si `amount` est absent du
  corps (`undefined`), ou une chaîne non numérique (faute de frappe, ex.
  `"10O"`), ou un objet/tableau à plus d'un élément, `Number(delta)` vaut
  `NaN`. **Vérifié dans `src/economy/money.js:3-7`** : `roundTWC` fait
  `if (!Number.isFinite(n)) return 0` — donc `target` ne devient PAS `NaN`
  en base, il devient silencieusement **0**, sans lever d'erreur nulle part
  dans la chaîne. Le reste de `adminSetBalance` (`ledger.js:608+`) traite
  alors ce `target: 0` comme une cible légitime : `diff = 0 - current`
  (négatif dès que `current > 0`), branche débit (`:629-654`) — vérifié
  `current < debit` est `current < current`, donc `false`, la garde ne
  bloque pas — et exécute `wallet.update({ balance: 0 })` **plus**
  `treasuryWallet.update({ balance: +current })` : le solde de
  l'utilisateur ciblé est mis à zéro et l'intégralité est transférée à la
  trésorerie, **sans validation, sans confirmation, sans distinction entre
  une faute de frappe et une action volontaire**. Effet concret : un
  opérateur `moderateur` qui oublie le champ `amount`, ou l'envoie mal
  typé, dans un appel à cette route efface silencieusement le solde TWC
  (monnaie à valeur réelle) du compte ciblé — pas de message d'erreur, pas
  de rollback à déclencher manuellement, juste un `success: true` avec
  `newBalance: 0`. Testé le raisonnement uniquement par lecture de code
  (pas d'exécution contre une base réelle dans cet audit), mais chaque
  étape de la chaîne est vérifiée ligne à ligne, y compris le comportement
  de `roundTWC` sur `NaN`. Second défaut associé, non testé jusqu'au bout :
  `userId` n'est pas non plus validé — si absent, `lockWallet` (`:105`)
  appelle `findOrCreateWallet(undefined, currencyId, ...)`, dont le
  comportement exact (erreur Sequelize/contrainte NOT NULL vs. création
  d'une ligne avec `userId: null`) n'a pas été vérifié plus loin — à
  creuser si utile, mais le défaut sur `amount` est déjà suffisant et
  confirmé. Correctif à transmettre : valider `userId` (entier positif,
  existant) et `amount` (nombre fini, non-nul) en entrée de route avant
  tout appel au ledger ; lever 400 sur échec plutôt que de laisser
  `Number()`/`roundTWC` absorber silencieusement une valeur invalide en 0.
  **NE PAS refaire cette recherche.**

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
  2. **VÉRIFIÉ, SAIN — NE PAS REFAIRE.** Limitation de débit sur mot de passe
     oublié (`authController.forgotPassword` → `authService.forgotPassword`,
     `src/services/authService.js:436-468`) : `authLimiter` (`server.js:301`)
     n'est monté que sur `/api/auth/login` et `/api/auth/register`
     (`server.js:311-312`), PAS sur `/forgot-password` — confirmé par
     `grep` sur `server.js`, seul le middleware global (1000/15min) couvre
     cette route. Mais impact vérifié faible : chaque appel écrase
     `reset_password_token`/`reset_password_expires` en base AVANT toute
     vérification (`:454-457`), donc aucune accumulation de jetons valides ;
     et `resetPassword` (`:482-484`) compare strictement
     `user.reset_password_token !== token`, donc un jeton écrasé devient
     inutilisable même s'il reste cryptographiquement valide (JWT non expiré)
     — la révocation logique fonctionne. De plus l'envoi d'e-mail est un
     `// TODO` jamais implémenté (`:459`, cf. B2-07) : à ce jour, appeler
     cette route en boucle ne délivre même pas de jeton exploitable à qui que
     ce soit d'autre que l'attaquant lui-même. Rien à corriger sur ce point
     précis tant que B2-07 n'est pas résolu ; à réévaluer l'ajout d'un
     `authLimiter` dédié le jour où l'envoi d'e-mail sera implémenté.
  3. **VÉRIFIÉ, SAIN — NE PAS REFAIRE.** Rejeu d'opération créditrice sur
     `/exchange` et `/transfer` (`newEconomyRoutes.js:97`, `:107` →
     `newEconomyController.js:300` `exchangeCurrency`, `:522` `transferCoins`) :
     validation de présence/type confirmée (`express-validator` sur les deux
     routes, faux positif du balayage brut). Aucune clé d'idempotence, donc
     un retry réseau peut exécuter l'opération deux fois — mais dans les
     deux cas les fonds déplacés appartiennent déjà à l'appelant (échange
     entre ses propres portefeuilles NF/EUR, virement depuis son propre
     solde verrouillé) : aucun chemin identifié pour en tirer un gain net,
     contrairement à `/purchase` qui, lui, mint depuis rien. Pas un vecteur
     d'enrichissement — désagrément fonctionnel possible seulement.
     **Piste déjà écartée pour `/campaigns/:id/fund` et `/advertisements/:id/fund`**
     (`adRoutes.js:650`, `:713`) : vérifié que `debitTWC` délègue à
     `NewEconomyService.spendCoins` → `EconomyLedger.spendToTreasury`, qui
     suit le même schéma de verrouillage de portefeuille que
     `mintFromPurchase` (déjà vérifié sain sur ce point précis en B1) — la
     vérification de solde dans la route elle-même est redondante mais
     inoffensive, l'enforcement réel est dans le ledger verrouillé.
  4. **VÉRIFIÉ, SAIN — NE PAS REFAIRE.** Réutilisation d'une autorisation
     `transaction_risk_authorizations` validée pour une opération différente
     de celle qui l'a obtenue (constat B1-02, fenêtre de survie à
     l'annulation) : `_requestHash` (`transactionAuthorizationService.js:310-316`)
     hache `{...operation, deviceFingerprint, paymentFingerprint}`, et
     `operation` (construit par `_normalizeOperation`, utilisé dans
     `authorize()` à `:872`) inclut `transactionKind`, `direction`, `amount`,
     `amountEur`, `currencyId`, `counterpartyUserId`, `merchantId` — pas
     seulement `userId`. `consume()` (`:1150-1178`) exige
     `AND request_hash = :requestHash` dans son `UPDATE ... WHERE`, donc une
     autorisation ne peut être consommée que par la requête exacte qui l'a
     produite (même montant, même devise, mêmes parties). Reste vrai que
     l'autorisation survit à l'annulation de la transaction qui l'a demandée
     (défaut de robustesse déjà noté en B1-02), mais elle n'est PAS
     réutilisable pour une opération différente — le risque se limite donc à
     rejouer la MÊME opération, ce qui rejoint le point 3 ci-dessus (pas de
     gain net identifié pour les routes qui passent par ce mécanisme).
  5. `src/routes/messageRoutes.js:59` (`requireGroupManagementRights` évalué
     hors transaction — constat B1-04, déjà documenté comme défaut de
     concurrence) : vérifié — la fenêtre ouvre uniquement sur la gestion de
     groupes de messagerie (changement de rôle membre, bannissement), sans
     donnée économique ni sensible en jeu ; exploiter la fenêtre exigerait
     qu'un admin de groupe soit rétrogradé au moment exact où il exécute une
     action de gestion, un cas marginal et sans gain pour l'attaquant
     au-delà de ce que la faille de concurrence déjà documentée en B1
     couvre. Pas de constat S3 distinct à ajouter ici — c'est bien seulement
     de la robustesse, pas une classe d'abus supplémentaire.
     **NE PAS refaire cette recherche.**

- **S3 — item 1, progrès partiel de cette passe (pas de nouveau constat
  publiable) :** `adRoutes.js` (`POST /campaigns`, `POST /advertisements`)
  vérifié — `total_budget`/`budget` ne sont testés que pour leur troncation
  (`!campaignData.total_budget`), pas pour leur type/signe. Un budget
  négatif ou non numérique traverse la vérification de solde
  (`adService.js:154`, comparaison `<` avec un NaN/négatif rend la garde
  inopérante) ET saute le débit (`:159`, `costTWC > 0` faux) — MAIS
  vérifié dans `src/models/Advertisement.js:36-49` que `isBudgetExhausted`
  (`spent >= this.budget`) et `getRemainingBudget`
  (`Math.max(0, budget - spent)`) rendent une telle publicité
  **immédiatement épuisée/à budget nul** dès sa création : aucun chemin
  identifié vers un service gratuit ou un gain, juste une entrée invalide
  et inutilisable. **Pas un constat à publier** (auto-neutralisé), mais pas
  formellement classé "sain" non plus faute d'avoir tracé tous les
  appelants de `isBudgetExhausted`/`getRemainingBudget` — à reprendre
  seulement si du temps reste après les candidats plus prioritaires.
  `eventPassRoutes.js` (`POST /verify`, `POST /redeem`) survolé : les deux
  passent par le middleware `doorAccess` et un `token` opaque vérifié par
  `eventPassService` — **pas encore tracé jusqu'à la vérification de
  signature elle-même**, à approfondir avant de classer sain.
  **Prochain pas concret :** revenir à la liste des 156 candidats bruts
  (reproductible avec `/tmp/scan.py` type — regex `router\.(post|put|patch)`
  sans validateur dans les 10 lignes suivantes), non encore triés :
  `messageRoutes.js` (12, le plus gros lot, pas encore ouvert),
  `advancedAdRoutes.js` (9 — IDOR déjà noté en S2, angle validation encore
  à vérifier séparément), `featureFlagRoutes.js` (9, admin — accès déjà
  probablement gated par rôle à confirmer comme pour economyAdminRoutes),
  `userChallengeRoutes.js` (9 — la route `/progress` déjà couverte en
  détail plus haut, les 8 autres candidats du fichier pas encore ouverts),
  `storyRoutes.js` (7), `eventPassRoutes.js` (6, dont `/verify`/`/redeem`
  ci-dessus), `infrastructureAdminRoutes.js` (6, admin), puis le reste par
  ordre décroissant de candidats.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `messageRoutes.js` (12 candidats
  bruts), angle validation uniquement (l'angle autorisation est couvert
  ailleurs).** Chaque route d'écriture relue en entier :
  `POST /direct/:userId` (contenu vidé/trim, borne de longueur pour compte
  non vérifié, `story_id` vérifié en base avec expiration) ; `POST /groups`
  (titre requis, `participantIds` filtré et vérifié en base un par un) ;
  `POST /conversations/:id/participants` (userId cible vérifié en base,
  liste des bannis consultée) ; `POST .../transfer-ownership` et
  `POST .../transfer-owner` (deux routes quasi dupliquées mais toutes deux
  vérifient le membre cible en base avant transfert — redondance de code,
  pas un défaut de sécurité) ; `POST .../members/:id/role` (`role` restreint
  à une énumération `['admin','member']`) ; `POST .../members/:id/ban` et
  `DELETE .../participants/:id` (mode restreint, cible vérifiée) ;
  `POST /:messageId/reactions` (`emoji` validé par `isSingleEmoji`, upsert
  correct via clé composite). Aucune route de ce fichier n'accepte de
  valeur brute non bornée sur un champ sensible. **Aucun constat.**

- **S3 — VÉRIFIÉ, SAIN (angle validation) — NE PAS REFAIRE.
  `advancedAdRoutes.js` (9 candidats bruts).** Toutes les routes d'écriture
  relues : `track-interaction`, `export-data`, `predict-performance`,
  `ab-test/create` (délègue à `adABTestingService.createABTest`, qui
  déstructure des champs nommés et appelle `validateTestConfig` — pas de
  mass-assignment), `ab-test/:id/assign-user`, `.../record-interaction`,
  `.../finalize`, `analytics/alert-thresholds/:id`, `cleanup-cache`. Aucune
  n'a de défaut de type/validation exploitable trouvé ; leur vrai problème
  (appartenance de la ressource jamais vérifiée) est déjà couvert en S2.
  **Point mineur relevé, non publié en constat séparé :**
  `POST /cleanup-cache` (`:544`) n'exige qu'un compte authentifié
  (`authenticateToken`, aucun contrôle de rôle) pour vider les caches
  partagés de cinq services publicitaires à la fois — pas de fuite de
  données ni de gain économique identifié, juste une dégradation de
  performance partagée déclenchable par n'importe quel utilisateur ; à
  signaler seulement si le temps le permet après les candidats plus
  prioritaires.

- **S3 — reprendre à :** prochain fichier de la liste des 156 candidats
  bruts, non encore ouvert : `featureFlagRoutes.js` (9,
  admin), `userChallengeRoutes.js` (8 restants hors `/progress` déjà
  traité), `storyRoutes.js` (7), `eventPassRoutes.js` (6, dont
  `/verify`/`/redeem` déjà survolés — vérification de signature du token
  encore à tracer), `infrastructureAdminRoutes.js` (6, admin), puis le
  reste par ordre décroissant.

- **S3 — CONSTAT CRITIQUE (3/3), déjà écrit, NE PAS REFAIRE : contournement
  total (stock ET `claimed`) de l'item exclusif "Badge Verifie Rose" via un
  chemin d'attribution automatique parallèle à `claim-special-reward`, plus
  une réécriture de seuil qui rend les défis triviaux à forger.** Chaîne
  vérifiée ligne à ligne, deux défauts qui se combinent :
  1. **`POST /api/user-challenges/` (`userChallengeRoutes.js:81`)** —
     authentification simple requise, aucune autre garde. Accepte
     `challenge_id`, `event_slug`, `max_progress` bruts du corps et appelle
     `UserChallenge.createOrUpdateChallenge` (`src/models/UserChallenge.js:126-148`) :
     `findOrCreate` sur `{user_id, challenge_id, event_slug}`, et si la ligne
     existe déjà, **écrase `max_progress` par la valeur du client** sans
     aucune borne (pas de minimum, `0` accepté). Donc n'importe quel compte
     peut, sur ses propres lignes de défi (pas un IDOR sur autrui), ramener
     le seuil réel de n'importe quel défi de n'importe quel événement à `0`.
  2. **`POST /api/user-challenges/update-progress/:eventSlug`
     (`userChallengeRoutes.js:228`)**, authentification simple requise, →
     `ChallengeProgressService.updateAllChallengesProgress`
     (`src/services/challengeProgressService.js:159-183`) : recalcule la
     progression réelle (`COUNT(*)` sur tweets/likes — ce point précis est
     sain, déjà vérifié) puis, **dans tous les cas, y compris si `progress
     >= max_progress` est vrai uniquement parce que `max_progress` a été
     mis à `0` à l'étape 1**, appelle
     `this.checkAndUnlockRoseStyle(userId, eventSlug)` (`:171`, défini
     `:189-211`).
  3. `checkAndUnlockRoseStyle` charge **tous** les `UserChallenge` de
     l'utilisateur pour l'`eventSlug` fourni (fourni par le client dans
     l'URL — pas restreint à `'kosporbirthday'` à ce niveau) et, si
     `challenges.every(c => c.completed)`, appelle directement
     `VerificationStyleService.unlockRoseStyle(userId)`
     (`src/services/verificationStyleService.js:140-165`) — **sans passer
     par `claim-special-reward`, sans vérifier `claimed`, et surtout SANS
     APPELER `checkRoseItemStock()` À AUCUN MOMENT DE CETTE CHAÎNE.**
  4. `unlockRoseStyle` exige seulement `user.verified === true` (gate réel,
     mais indépendant du système de défis) puis `canUseRoseStyle` (`:100-133`)
     qui retourne `true` dès que `challenges.every(c => c.completed)` sur
     `event_slug: 'kosporbirthday'` codé en dur ici (donc l'`eventSlug`
     arbitraire de l'étape 3 ne sert à rien pour ce garde-fou précis — il
     faut que les lignes forgées portent bien `event_slug: 'kosporbirthday'`) ;
     **le commentaire du code à cet endroit dit explicitement "NE PAS
     ajouter l'item ici - il sera ajouté uniquement lors du claim de la
     récompense finale"** — c'est l'intention documentée par l'auteur
     lui-même. Pourtant, juste après ce commentaire, `unlockRoseStyle`
     (appelé automatiquement, pas par un claim explicite) fait exactement
     l'inverse : `:157` `await this.addRoseItemToInventory(userId)`, qui
     (`:170-184`) appelle `InventoryService.addItemToUser` — vérifié
     (`src/services/inventoryService.js:12-40`) qu'**aucune vérification de
     stock n'existe à ce niveau non plus**, juste un `INSERT ... ON
     CONFLICT` qui incrémente la quantité.
  **Effet concret, vérifié de bout en bout :** un compte "verified"
  quelconque peut obtenir l'item exclusif à stock plafonné à 100
  (`checkRoseItemStock`, `MAX_STOCK = 100`) **sans jamais passer par le
  contrôle de stock**, en trois appels HTTP scriptables sur ses 3 lignes de
  défi `kosporbirthday` (`POST /` ×3 avec `max_progress: 0`, puis
  `POST /update-progress/kosporbirthday` une fois) — et ceci fonctionne même
  sans la forge de `max_progress` : un utilisateur ayant complété les seuils
  réels (5 tweets, 5 likes, plus l'appel libre `complete-birthday-wish` déjà
  documenté comme non vérifié) obtient AUSSI l'item automatiquement à la
  prochaine mise à jour de progression, sans jamais appeler
  `claim-special-reward` ni être compté dans son contrôle de stock — donc le
  plafond de 100 objets peut être dépassé par la simple accumulation
  d'utilisateurs légitimes, pas seulement par un abus délibéré.
  **C'est le constat le plus sévère de la section S3** : il ne contourne pas
  seulement la vérification d'activité (comme le constat critique 2/2 déjà
  documenté), il élimine aussi le plafond de stock lui-même, sur un item
  dont le code montre par son propre commentaire que ce plafond était censé
  être respecté.
  Correctif à transmettre : supprimer l'appel à `addRoseItemToInventory`
  dans `unlockRoseStyle` (le rendre cohérent avec son propre commentaire —
  ne changer que `verification_style` en affichage si l'item est déjà
  possédé, jamais l'attribuer) ; faire passer toute attribution de l'item
  par le chemin unique `claim-special-reward` qui, lui, vérifie le stock et
  l'absence de doublon ; et corriger `POST /api/user-challenges/` pour ne
  jamais permettre au client de fixer `max_progress` sur un défi déjà
  initialisé (recalculer ce seuil côté serveur depuis une table de
  définitions d'événement, jamais depuis le corps de la requête).
  **NE PAS refaire cette recherche.**

- **S3 — `userChallengeRoutes.js` TERMINÉ (9/9 candidats).**
  `POST /complete-birthday-wish/:eventSlug` (`:309`) — vérifié :
  `ChallengeProgressService.completeBirthdayWishChallenge` (:295-332) marque
  le défi `wish_birthday` `progress=1/max_progress=1` **inconditionnellement**,
  sans aucune vérification qu'un souhait a réellement été posté nulle part
  dans le code. C'est un contributeur au constat critique 3/3 ci-dessus (un
  des trois défis nécessaires à `allCompleted`), pas un constat distinct —
  fusionné dans le correctif transmis (le vrai problème est en aval,
  `unlockRoseStyle`/`checkAndUnlockRoseStyle`, pas cette route précise qui
  reste discutable mais mineure isolément). `POST /` et
  `PUT /:challengeId/progress` déjà couverts (constats 3/3 et 2/2).
  `POST /:challengeId/claim`, `update-progress`, `update-likes-progress`,
  `update-tweets-progress`, `initialize/:eventSlug`,
  `claim-special-reward/:eventSlug` déjà couverts. **Fichier clos.**

- **S3 — CONSTAT ÉLEVÉ (nouveau), déjà écrit, NE PAS REFAIRE :
  `src/routes/storyRoutes.js:518` `POST /api/stories` — upload vidéo de
  story écrit le buffer BRUT sur disque, sous une extension non filtrée,
  dans un répertoire servi publiquement sans transformation.** Vérifié
  ligne à ligne :
  1. `fileFilter` du `multer` (`:43-52`) ne teste que le `mimetype` déclaré
     par le client (`^(image|video)\/`) — entièrement falsifiable, même
     défaut que pour l'upload vidéo de tweet déjà documenté.
  2. Branche `isVideo` (`:527-535`) : `extension =
     path.extname(req.file.originalname).toLowerCase() || '.mp4'` —
     **aucune liste blanche**, contrairement à la branche image du même
     fichier (voir point 4). `path.extname` confirmé sans risque de
     traversée de répertoire (même vérification que pour l'upload vidéo de
     tweet), mais l'extension elle-même peut être n'importe quoi
     (`.html`, `.svg`, `.js`...).
  3. **Différence clé avec l'upload vidéo de tweet (déjà documenté, constat
     moyen) : ici il n'y a AUCUN retraitement.** `fs.writeFileSync(outputPath,
     req.file.buffer)` écrit le contenu envoyé par le client **tel quel**,
     sans passer par `ffmpeg` ni aucun décodeur qui validerait le contenu
     réel. Le fichier atterrit directement dans `STORIES_DIR`
     (`src/public/stories`), servi sans traitement par
     `express.static(path.join(__dirname, './public'), ...)` monté sur
     `/static` (`server.js:381`) — confirmé par `buildStaticMediaPublicUrl`
     (`src/utils/publicMediaOrigin.js:35-39`), qui construit l'URL publique
     comme `{origin}/static/stories/{filename}`. `express.static`
     (`serve-static`/`send`) déduit le `Content-Type` HTTP de la réponse à
     partir de l'extension du fichier.
  4. Par contraste, la branche image du même fichier (`:541-548`) passe le
     contenu par `sharp()` avant écriture (validation de fait + sortie
     `.jpg` forcée) — le même garde-fou que celui déjà jugé sain ailleurs
     dans ce dépôt pour les avatars/bannières/images de tweet. **Ce
     garde-fou n'existe que pour les images ici, pas pour les vidéos.**
  **Effet concret, vérifié jusqu'à la config du serveur statique :** un
  compte authentifié non suspendu peut publier une "story" en déclarant
  `Content-Type: video/mp4` avec un `originalname` de son choix (ex.
  `x.html`) et un corps de requête contenant du HTML/JS arbitraire ; le
  fichier est enregistré tel quel sous `/static/stories/story-<uid>-<ts>-<r>.html`
  et servi avec `Content-Type: text/html` par le serveur — un cas classique
  de téléversement de fichier menant à un XSS stocké sur le domaine de la
  plateforme elle-même, à une URL prévisible et publique, tant que la story
  n'a pas expiré (purge horaire des stories expirées confirmée à
  `server.js:1086`, donc fenêtre bornée à la durée de vie d'une story, pas
  illimitée). **Non vérifié depuis le code serveur seul** : si les clients
  officiels (web/mobile) ouvrent jamais cette URL brute dans un contexte qui
  exécute le script (navigation directe, `<iframe>`/`<object>`, ou un
  navigateur externe suivant un lien partagé) — un `<video>`/`<img>` normal
  n'exécuterait pas le contenu, donc l'impact réel dépend du rendu côté
  client, non audité ici. Le défaut serveur (absence totale de
  validation/retraitement du contenu vidéo avant publication) est, lui,
  confirmé avec certitude. Correctif à transmettre : appliquer à la branche
  vidéo le même traitement que la branche image — au minimum une liste
  blanche d'extensions (`.mp4`, `.mov`, `.webm`, `.m4v`) déterminée par le
  `mimetype` validé, jamais par le nom de fichier client, et idéalement un
  passage par `ffprobe`/`ffmpeg` avant écriture dans le répertoire public,
  comme c'est déjà fait pour les vidéos de tweets.
  **NE PAS refaire cette recherche.**

- **S3 — `storyRoutes.js` TERMINÉ (7/7 candidats), reste sain hormis le
  constat ci-dessus.** `POST /highlights`, `PATCH|PUT /highlights/:id`,
  `POST /highlights/:id/items` : `storyIds`/`coverStoryId` toujours vérifiés
  par `ownedStories`/`ownedHighlight` (appartenance à `req.user.id`), titre
  borné à 40 caractères. `POST /:storyId/view` : idempotent via contrainte
  unique, ne fait qu'incrémenter un compteur. `PUT /:storyId/like` : pas
  encore relu en détail (probable même motif que `view`, faible risque) —
  à rouvrir seulement si du temps reste, sinon considérer le fichier clos.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `eventPassRoutes.js` (6/6
  candidats), y compris la vérification de signature du token qui restait
  à tracer.** `doorAccess` (`:118-135`) exige soit un `door_token` HMAC
  valide (`eventPassService.verifyDoorToken`), soit un rôle modérateur via
  `authenticateToken`+`requireModeratorRole`. Le token de porte et le code
  de place sont tous deux signés par `crypto.createHmac('sha256',
  signingKey())` avec comparaison en temps constant
  (`crypto.timingSafeEqual`, `:106` et `:276` de `eventPassService.js`) —
  implémentation cryptographique saine, clé dérivée de
  `EVENT_PASS_SECRET`/`JWT_SECRET`, jamais codée en dur. `POST /verify` et
  `POST /redeem` ne font que passer le `token` du corps à ce service, qui
  fait toute la vérification. Les 4 routes restantes (`/batch`,
  `/events/:slug/door-link`, `/:id/revoke`, `/:id/restore`) sont toutes
  `requireAdminRole`, et délèguent la validation de leur payload au
  service. **Aucun constat.**

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `infrastructureAdminRoutes.js`
  (6/6 candidats).** Toutes les routes derrière un middleware de niveau
  routeur (`:69`, `requireInfrastructureAdminRole`) qui **revérifie le rôle
  en base à chaque requête** (pas seulement le rôle signé dans le JWT), avec
  un repli explicite et journalisé sur le rôle JWT uniquement si la base est
  injoignable — compromis documenté et raisonnable (le cockpit doit pouvoir
  redémarrer PostgreSQL après un arrêt manuel). Les routes qui `spawn` des
  processus systèmes (`nodes/:id/:action`, `databases/:id/:action`,
  `replicas/:id/:action`) valident `id`/`action` par liste blanche stricte
  avant construction de la commande (`validateSystemAction`,
  `:445-466` : `node` limité à `['A','B']`, `action` à
  `['start','stop','restart','failback']`, combinaison `failback`
  restreinte en plus), exigent une phrase de confirmation tapée
  correspondant exactement à l'action, et utilisent `spawn` avec des
  arguments en tableau (jamais une chaîne shell) — aucune injection de
  commande possible. `load-tests` (`:533`) borne `users`/`duration`/
  `interval` avec un plafond de débit calculé, et exige aussi une phrase de
  confirmation. **Aucun constat.**

- **S3 — balayage brut RE-GÉNÉRÉ (script Python identique, fichiers déjà
  couverts exclus) : liste à jour des candidats restants, par ordre
  décroissant.** `adRoutes.js` (11 — argent, déjà partiellement survolé :
  `total_budget` non typé, jugé auto-neutralisé, à re-regarder pour les 10
  autres candidats), `authRoutes.js` (9 — critique), `events.js` (8),
  `userRoutes.js` (6), `progressiveRecommendationRoutes.js` (6),
  `functionalEventRoutes.js` (5), `creatorIntelligenceRoutes.js` (5),
  `economyAdminRoutes.js` (4 — argent, 1/4 déjà couvert : `PUT
  /wallets/balance`), `neuralRankRoutes.js` (4), `supportRoutes.js` (4),
  `tweetRoutes.js` (3), `nfMapRoutes.js` (3), `featureProposalRoutes.js` (3),
  `policierCongoAdminRoutes.js` (3), `contestRoutes.js` (3),
  `premiumRoutes.js` (2 — argent), `monetizationProgramRoutes.js` (2 —
  argent), `gAuthRoutes.js` (2 — auth), `monetizationRoutes.js` (2 —
  argent), `aiRecommendationRoutes.js` (2), `tweetMonetizationRoutes.js`
  (2 — argent), `userSimilarityRoutes.js` (2, déjà noté en S2 comme
  n'utilisant pas `authenticateToken` importé — à re-vérifier sous l'angle
  validation), puis 12 fichiers à 1 candidat chacun dont `walletRoutes.js`,
  `paymentRoutes.js`, `inventoryRoutes.js` (argent/objets),
  `developerAdminRoutes.js`, `shadowbanAdminRoutes.js` (admin).
  **Prochain pas concret :** prioriser `adRoutes.js`, `authRoutes.js`,
  `economyAdminRoutes.js` (candidats restants), `paymentRoutes.js`,
  `walletRoutes.js`, `premiumRoutes.js`, `monetizationRoutes.js`,
  `tweetMonetizationRoutes.js`, `inventoryRoutes.js` avant le reste (argent
  et authentification en premier, conformément à la priorité de la
  section).

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `walletRoutes.js:123`
  `POST /transfer`.** Utilise `NewEconomyService.transferCoins` →
  `EconomyLedger.transferP2P` (`src/economy/ledger.js:382-450`), qui appelle
  `assertPositive(amount)` (`src/economy/money.js:40-46`) **avant** tout
  usage du montant : `assertPositive` fait `roundTWC(amount)` puis rejette
  si `<= 0` — donc un montant `NaN` (ex. corps malformé) est bien rejeté
  (`roundTWC(NaN)` vaut `0`, `0 <= 0` lève une erreur), contrairement au
  défaut déjà documenté dans `economyAdminRoutes.js` où `roundTWC(NaN)`
  n'était PAS revérifié après coup. Verrouillage de portefeuille, solde
  suffisant vérifié, transfert interdit vers soi-même. Route saine.

- **S3 — CONSTAT CRITIQUE (4/4), déjà écrit, NE PAS REFAIRE, LE PLUS
  DIRECT DE LA SECTION : `src/routes/paymentRoutes.js:20`
  `POST /api/payments/apple-pay` — route de paiement explicitement
  factice, jamais reliée à un vrai fournisseur, qui crédite directement le
  portefeuille de l'appelant jusqu'à 1000 € par appel, sans limite de
  débit dédiée.** Le code lui-même documente son propre défaut : le
  commentaire du fichier dit littéralement "Route pour simuler un paiement
  Apple Pay" et "Simuler le traitement du paiement Apple Pay" (`:19`,
  `:49`) — ce n'est pas une supposition, c'est écrit noir sur blanc par
  l'auteur original.
  1. Le corps de requête n'est validé que sur sa FORME (`express-validator`,
     `:20-24`) : `amount` doit être un flottant entre `0.01` et `1000`,
     `currencyId` un UUID existant et actif, `paymentMethod` une chaîne non
     vide (jamais vérifiée contre une liste, contrairement à d'autres
     routes du dépôt) — **aucune de ces règles ne vérifie qu'un paiement a
     réellement eu lieu.**
  2. `checkTransaction` (`fraudMiddleware.js`, monté `:17` sur tout le
     routeur) est le même moteur de score de risque comportemental déjà
     vérifié pour le constat critique 1/3 (`/purchase`) : il évalue si la
     transaction est suspecte, **il ne vérifie à aucun moment qu'un
     paiement a eu lieu.**
  3. Aucun appel à un SDK ou une API Apple (`PassKit`, App Store Server
     API, vérification de reçu) nulle part dans le gestionnaire — confirmé
     par la recherche déjà faite pour le constat 1/3
     (`grep -rln "stripe|verifyReceipt|apple.*receipt..." src/` → aucun
     résultat pertinent dans ce fichier non plus) et par la lecture
     complète du fichier (98 lignes utiles) : une attente artificielle de
     2 secondes (`:53`, commentaire "Simuler un délai de traitement"), un
     identifiant de transaction Apple Pay généré côté serveur par
     `crypto.randomBytes` (`:76`, donc jamais vérifié contre Apple), c'est
     tout.
  4. Le crédit est réel et direct : `wallet.update({ balance: newBalance
     ... })` (`:124-127`) où `newBalance = wallet.balance + ninfiAmount`,
     `ninfiAmount = amount / currency.currentPrice` — **ce chemin ne passe
     même pas par `ledger.mintFromPurchase` du constat 1/3, c'est un
     TROISIÈME code path de crédit direct, distinct des deux autres déjà
     documentés dans cette section.** Verrouillage de ligne
     (`lock: dbTransaction.LOCK.UPDATE`, `:63`) présent, donc pas de souci
     de concurrence sur ce point précis — le défaut est uniquement
     l'absence de vérification de paiement.
  5. **Différence clé avec le constat 1/3 (`/purchase`), qui aggrave la
     sévérité :** `/purchase` résout le prix côté serveur via une liste
     fermée de forfaits (`PURCHASE_PACKAGES.find(...)`) ; **ici, le client
     fixe directement `amount` en euros (jusqu'à 1000 €), sans aucune
     grille de prix côté serveur.** Aucune limite de débit dédiée sur cette
     route (confirmée par lecture de `server.js` — seule
     `app.use('/api/payments', paymentRoutes)` à `:518`, aucun limiteur
     spécifique), donc seul le quota global (1000 requêtes/15 min, lui-même
     désactivable par l'usurpation first-party déjà documentée en constat
     moyen) borne le débit : à la limite légale de ce quota seul, un compte
     peut générer jusqu'à 1 000 000 € de contre-valeur en monnaie de la
     plateforme par tranche de 15 minutes, sans jamais payer un centime.
  **C'est, de tous les constats S3, le plus direct à exploiter** : pas de
  chaîne à plusieurs étapes, pas de forge de champs obscurs — un seul appel
  HTTP avec un corps JSON valide au sens du validateur suffit.
  Correctif à transmettre : retirer cette route de la production tant
  qu'aucune intégration réelle avec Apple (App Store Server API, validation
  de reçu signé) n'existe, ou la protéger derrière un indicateur
  d'environnement de test explicite et un compte de démonstration désigné —
  jamais accessible à un compte de production quelconque.
  **NE PAS refaire cette recherche.**

- **S3 — `paymentRoutes.js` TERMINÉ (1/1 candidat brut, mais fichier lu en
  entier vu la gravité).** `POST /apple-pay/check` (`:266`) est un
  placebo sans effet de bord (répond toujours `isAvailable: true` sans
  toucher à aucune donnée) — pas un constat à part, seulement un signe
  supplémentaire que ce fichier entier est une maquette non finalisée.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `economyAdminRoutes.js` TERMINÉ
  (4/4, dont les 3 candidats restants après `updateWalletBalance` déjà
  documenté élevé).** `fraudBurn` (`economyAdminController.js:65-102`)
  valide chaque item avec `Number(item.amount) > 0` — `NaN > 0` vaut
  `false`, donc bien rejeté (contrairement au défaut déjà documenté sur
  `updateWalletBalance`, qui ne revérifiait pas après coup). `manualTransfer`
  (`:303-360`) : le contrôleur lui-même a la même garde faible que
  `updateWalletBalance` (`transferAmount <= 0` laisse passer un `NaN`),
  **MAIS** ses deux branches délèguent respectivement à
  `EconomyLedger.adminCredit` (`ledger.js:560-586`) et `spendToTreasury`
  (`ledger.js:211+`), qui appellent toutes deux `assertPositive(amount)`
  AVANT tout usage — `assertPositive` fait `roundTWC` puis rejette
  strictement `<= 0`, donc un montant invalide y échoue proprement (erreur
  levée, 500 avec message, capturé par le `catch`), **sans jamais atteindre
  l'écriture en base.** Ceci confirme, par contraste, que le défaut déjà
  documenté sur `adminAdjustBalance` (`PUT /wallets/balance`) est une
  anomalie isolée : c'est la seule fonction du ledger examinée jusqu'ici
  qui n'appelle pas `assertPositive` avant d'écrire un solde. `toggleWalletLock`
  (`:362-390`) : pas de montant, `userId` non trouvé → 404 propre. **Fichier
  clos, aucun nouveau constat.**

- **S3 — CONSTAT CRITIQUE (5/5), déjà écrit, NE PAS REFAIRE : `adRoutes.js`,
  les deux routes `PUT` de mise à jour du module publicitaire.** Assignation
  de masse : le corps de requête est transmis tel quel à la méthode de mise
  à jour du modèle, sans restriction de champs, ce qui permet d'écrire
  directement des colonnes financières et un champ d'état que le dépôt
  destine par ailleurs à un flux contrôlé côté serveur (financement,
  activation). Détail complet — noms de route, noms de champs, chaîne de
  conséquence vérifiée jusqu'au bout — transmis au propriétaire hors dépôt,
  pas ici (dépôt public, voir avertissement en tête de fichier). Correctif à
  transmettre : restreindre chaque `.update()` à une liste blanche explicite
  de champs modifiables par le client, distincte des champs financiers/état
  qui ne doivent transiter que par les routes dédiées déjà existantes.
  **NE PAS refaire cette recherche.**

- **S3 — `adRoutes.js` — candidats restants examinés à ce stade (hors le
  constat ci-dessus et le candidat `total_budget` déjà noté « auto-neutralisé »
  au tour précédent) : routes `/campaigns` (POST), `/advertisements` (POST),
  `/campaigns/:id/fund` (POST), `/advertisements/:id/fund` (POST) — les
  quatre vérifiées SAINES : tout débit réel passe par le grand livre, qui
  rejette lui-même une valeur non strictement positive avant toute écriture
  (même garde que celle déjà confirmée saine sur `walletRoutes.js` et
  `economyAdminRoutes.js`) ; la création de publicité ne débite que si le
  budget déclaré est strictement positif après conversion, sinon aucun débit
  n'a lieu (pas de gain net possible pour l'appelant, seulement un
  enregistrement incohérent dans ce cas limite). Il reste des routes
  `GET`/ciblage non revues (statistiques, audiences) — probablement à faible
  risque (lecture seule), à confirmer si le temps le permet, sinon fichier
  considérable comme couvert sur son périmètre à risque (écriture/argent).**

- **S3 — mise à jour de la liste de priorité :** `adRoutes.js` et
  `authRoutes.js` traités (voir ci-dessus/ci-dessous). Prochain pas concret =
  `premiumRoutes.js`, `monetizationRoutes.js`, `tweetMonetizationRoutes.js`,
  `inventoryRoutes.js`, `monetizationProgramRoutes.js` (tous « argent »),
  avant le reste de la liste régénérée au tour précédent (`events.js`,
  `userRoutes.js`, `progressiveRecommendationRoutes.js`, etc.).

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `authRoutes.js` (9/9 candidats
  bruts).** Vérifié en détail car priorité haute (authentification) :
  `register`/`login` ont un limiteur de débit dédié (`server.js:301-312`,
  100/15 min), contrairement à `forgot-password` — mais ce point précis est
  déjà documenté sain dans la liste « vérifié sain » plus haut (jetons
  écrasés à chaque demande, envoi d'e-mail non implémenté, donc pas
  d'accumulation ni de fuite exploitable pour l'instant). `PUT /profile`
  (`authService.js:586` `updateProfile`) : **liste blanche de champs
  explicite** (`allowedFields`, une boucle nommée) avant toute écriture —
  contrairement au constat critique 5/5 sur `adRoutes.js`, aucune assignation
  de masse ici ; changer de pseudo revoque la vérification du compte
  (comportement voulu, pas un défaut). `updateDemographics`,
  `changePassword`, `resetPassword` (token JWT signé vérifié avant toute
  comparaison, donc la comparaison de chaîne non constante en temps sur le
  jeton stocké n'est pas exploitable), `sessions`/`revokeSession` (scopés
  `user_id`) : tous à paramètres nommés ou scope vérifié, rien trouvé.
  `register` (service) : whitelist explicite (`username`, `full_name`,
  `password`, `platform`), aucun champ de rôle/statut acceptable depuis le
  client. `/stats`, `/search`, `/popular`, `/performance-test` : routes non
  implémentées (stubs), aucune donnée réelle exposée. **Aucun constat.**

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `premiumRoutes.js` (0 candidat
  restant) et le parcours d'achat d'abonnement réel
  (`userRoutes.js:1687` `POST /purchase-subscription`, fonction
  `handleSubscriptionPurchase`, `userRoutes.js:122`).** L'ancien parcours
  premium (Apple Pay simulé) est désactivé (routes `/subscribe`, `/cancel`,
  `/plans` répondent `410`) — seul `/status` (lecture) reste actif. Le
  parcours en vigueur calcule prix ET durée **entièrement côté serveur**
  (`resolveSubscriptionPricing`), avec un commentaire confirmant qu'une
  faille de durée négociable par le client (`req.body.duration`, sans
  plafond) a déjà été corrigée — vérifié qu'elle ne l'est plus (la durée est
  la constante `DEFAULT_DURATION_DAYS`, jamais lue depuis `req.body`).
  Verrouillage de ligne (`NO_KEY_UPDATE`) avant lecture du solde, débit via
  `spendCoins` → même garde `assertPositive` que le reste du grand livre.
  **Aucun constat.**

- **S3 — CONSTAT MOYEN (3/3), déjà écrit, NE PAS REFAIRE : module
  `monetization` (route + modèle de métriques de monétisation par tweet).**
  Une route d'écriture, réservée au propriétaire du tweet (vérifié :
  comparaison stricte `tweet.user_id !== req.user.id`, donc pas d'IDOR),
  transmet trois champs du corps de requête directement à la méthode de
  sauvegarde du modèle, sans validation de type ni de borne sur aucun des
  trois — dont celui qui représente un montant. Recherche menée dans
  l'ensemble du dépôt pour un lien entre ce champ et un versement réel
  (portefeuille, grand livre) : **aucun trouvé** — le champ semble
  purement une statistique d'affichage agrégée ensuite dans un tableau de
  bord consultable par ce même compte, d'où la gravité moyenne et non
  critique. Correctif à transmettre : si ce module doit rester en
  production, calculer ces trois champs côté serveur à partir de
  l'activité réelle (vues/clics comptés en base), comme c'est déjà fait
  pour les défis (`challengeProgressService.js`) ; sinon le retirer comme
  l'ancien parcours premium l'a été. **NE PAS refaire cette recherche.**

- **S3 — `monetizationRoutes.js` TERMINÉ (5/5 candidats).** Les deux
  routes `GET` restantes (`eligible-tweets`, `stats`) sont des lectures
  scopées à l'utilisateur courant ou globales sans donnée sensible.
  `POST /tweets/:tweetId/simulate` (`simulateEngagement`) a la même garde
  de propriété que `updateMetrics` (vérifiée), et recalcule les métriques
  via une fonction serveur (`MonetizationMetrics.simulateEngagement`) sans
  prendre aucune valeur du corps de requête — pas un constat séparé, une
  route de test laissée accessible mais qui ne prend aucune entrée
  arbitraire du client.

- **S3 — prochain pas concret :** `tweetMonetizationRoutes.js`,
  `inventoryRoutes.js`, `monetizationProgramRoutes.js` (tous petits
  fichiers, non encore ouverts), puis le reste de la liste régénérée
  (`events.js`, `userRoutes.js` — hors la portion déjà vérifiée saine
  ci-dessus —, `progressiveRecommendationRoutes.js`, etc.).

- **S3 — CONSTAT CRITIQUE (6/6), déjà écrit, NE PAS REFAIRE : module
  `tweetMonetizationService` (fichier `tweetMonetizationRoutes.js` +
  service associé), route de distribution directe.** Chaîne vérifiée de
  bout en bout dans le code : la route accepte à la fois l'identifiant du
  tweet et l'identifiant du bénéficiaire depuis la requête du client, sans
  jamais vérifier que ce bénéficiaire est l'auteur réel du tweet désigné —
  seule sa propre éligibilité au programme de monétisation est vérifiée,
  pas son lien avec le tweet. Le montant est recalculé à chaque appel à
  partir de compteurs d'engagement cumulés (vues, likes, commentaires,
  partages, temps de visionnage), **sans jamais les remettre à zéro ni
  marquer l'opération comme déjà effectuée** — contrairement au chemin
  automatisé équivalent du même service, qui lui remet ces compteurs à
  zéro et pose un indicateur dédié après paiement (vérifié dans le code :
  c'est la seule fonction du service qui le fait, et la route directe ne
  l'appelle jamais). Aucun limiteur de débit dédié sur cette route (vérifié
  dans `server.js` — seul le quota global s'applique, lui-même
  contournable par l'usurpation first-party déjà documentée en constat
  moyen). Le montant crédité passe par `NewEconomyService.rewardUser` →
  le grand livre, donc plafonné par la trésorerie disponible mais pas par
  autre chose. **Impact vérifié :** un compte qui remplit légitimement la
  condition d'accès (abonnement payant actif + programme de monétisation
  accepté) peut rejouer ce montant indéfiniment sur son propre tweet sans
  aucune nouvelle activité, et/ou le rediriger vers son propre compte
  depuis un tweet appartenant à un autre créateur également éligible.
  Correctif à transmettre : faire porter cette route par le même mécanisme
  de consommation d'état que le chemin automatisé (compteurs remis à zéro
  et tweet marqué comme déjà monétisé dans la même transaction que le
  crédit), et dériver le bénéficiaire de l'auteur réel du tweet plutôt que
  d'un champ du corps de requête. **NE PAS refaire cette recherche.**

- **S3 — `tweetMonetizationRoutes.js` — reste à vérifier :** les routes
  `GET` (`rpm-rates`, `eligibility/:tweetId`, `reward/:tweetId`, `stats`,
  `preview`, `preview-earnings`, `user/:userId/eligible`) et la route
  `POST /process-all` elle-même (son propre appel interne à
  `distributeReward` avec un montant précalculé — voir le commentaire du
  code cité dans le constat 6/6 : ce paramètre existe précisément pour ce
  chemin-là) — probable, mais pas encore formellement confirmé que ce
  chemin-ci est sain de bout en bout au-delà de ce qui est déjà noté.
  `inventoryRoutes.js`, `monetizationProgramRoutes.js` toujours pas ouverts.

- **S3 — CONSTAT CRITIQUE (7/7), déjà écrit, NE PAS REFAIRE : `inventoryRoutes.js`,
  route `POST /user/:userId/use-item`, service `inventoryService.js`
  `useItem`.** La route vérifie bien que `userId` du chemin correspond à
  l'appelant (pas d'IDOR sur ce point), mais lit `quantity` du corps de
  requête sans jamais vérifier qu'elle est strictement positive avant de la
  transmettre au service. Le service exécute une requête SQL brute de la
  forme `UPDATE ... SET quantity = quantity - :quantity ... WHERE quantity
  >= :quantity` : avec une valeur négative, la soustraction devient une
  addition, et la clause de garde (comparée dans le même sens) ne bloque
  rien puisqu'une quantité en stock est presque toujours ≥ une valeur
  négative. Nécessite de posséder déjà au moins un exemplaire de l'objet
  visé (la jointure ne crée pas de ligne), mais aucune borne au-delà — un
  seul appel peut multiplier la quantité possédée par un facteur arbitraire.
  Combiné aux constats déjà documentés sur les récompenses à stock limité
  (constat critique 2/2 et 3/3 de cette section), un objet exclusif obtenu
  une seule fois par ces chemins peut ensuite être multiplié à volonté par
  celui-ci. Correctif à transmettre : rejeter toute `quantity` non entière
  strictement positive avant l'appel au service, et par prudence
  réécrire la requête pour ne jamais dépendre du signe du paramètre côté
  SQL (`GREATEST(quantity - :quantity, 0)` avec `:quantity` déjà validé
  positif en amont, ou recalculer la nouvelle valeur en JS et l'assigner
  plutôt que de la dériver par soustraction en base). **NE PAS refaire
  cette recherche.**

- **S3 — `inventoryRoutes.js` TERMINÉ (3/3 candidats).** `GET
  /user/:userId` et `GET /user/:userId/has-item/:itemName` sont en lecture
  seule, correctement scopées (soi-même, ou admin/superadmin pour la
  première) — aucun constat sur ces deux-là au-delà du constat critique
  ci-dessus.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `monetizationProgramRoutes.js`
  (2/2 candidats).** `POST /apply` ne prend aucun champ du corps de
  requête, appelle le service uniquement avec `req.user.id` — aucune
  auto-approbation possible côté client. Les deux routes `/admin/*` sont
  derrière `requireAdmin`. **Aucun constat.**

- **S3 — `userRoutes.js` — vérifié sain en cours de route (pas le focus de
  ce tour, mais examiné en profitant d'être déjà dans le fichier pour le
  constat S2 ci-dessus) : `follow-requests/:followId/accept`,
  `/reject`, `DELETE /followers/:followerId` — tous scopés
  `following_id`/`follower_id: req.user.id` ; `POST /:id/block`,
  `/:id/unblock` — scopés `currentUserId`, auto-blocage explicitement
  refusé. **Pas encore examinés dans ce fichier :** `onboarding/follows`,
  `POST /:id/follow`, `DELETE /:id/follow`, `POST /me/avatar`,
  `POST /me/banner`, `PUT /me/language`. À couvrir au prochain tour avant
  de considérer `userRoutes.js` clos pour S3.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `userRoutes.js` TERMINÉ pour S3
  (les 6 candidats restants).** `POST /onboarding/follows` : `userIds`
  validé (`isArray` borné 3–30, `isUUID` par élément), dédupliqué, exclut
  l'appelant, puis re-filtré en base sur `is_active`/`is_suspended`/
  `is_private_account` avant toute création — aucun suivi forgé sur un
  compte non suivable. `POST /:id/follow` et `DELETE /:id/follow` :
  `param('id').isUUID()`, auto-suivi refusé, existence/état de la cible
  vérifiés en base, statut `pending` forcé si compte privé (pas de
  contournement de la confidentialité). `POST /me/avatar` et
  `POST /me/banner` : même motif déjà jugé sain ailleurs (`sharp()` avant
  écriture, nom de fichier entièrement généré côté serveur
  `${userId}-${Date.now()}-${uuid}.jpg`, aucune traversée de chemin
  possible). `PUT /me/language` : valeur comparée à une liste blanche
  fermée `READABLE_LANGUAGES`, rejetée sinon. **Aucun constat.**

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `gAuthRoutes.js` (2/2
  candidats).** `POST /link-token` : authentifié, émet un JWT court
  portant `userId: req.user.id` uniquement (`gAuthService.issueLinkToken`)
  — aucune entrée client. `POST /backchannel` : pas d'authentification
  utilisateur, mais protégé par un secret partagé
  (`G_AUTH_BACKCHANNEL_SECRET`) comparé en temps constant
  (`crypto.timingSafeEqual`, longueurs égalisées avant comparaison —
  implémentation correcte), corps restreint à `{event: 'consent.revoked',
  sub}` sinon 400. `unlinkBySub` (`gAuthService.js:392`) résout `sub` par
  recherche en base (`g_auth_sub`), scope correct, aucune action si compte
  introuvable. **Aucun constat.**

- **S3 — CONSTAT MOYEN (4/4), déjà écrit, NE PAS REFAIRE :
  `src/routes/progressiveRecommendationRoutes.js` — module entier de routes
  de maintenance du moteur de recommandation protégé par `authenticateToken`
  seul, sans contrôle de rôle ni limite de débit dédiée, deux d'entre elles
  déclenchant chacune des centaines à des milliers d'opérations séquentielles
  en base par appel.** Vérifié route par route (6 candidats bruts,
  toutes montées `authenticateToken` seul, aucun `requireAdmin`/rôle
  nommé, confirmé par lecture complète du fichier et de
  `server.js:543` — `app.use('/api/progressive-recommendations',
  progressiveRecommendationRoutes)`, aucun middleware englobant, aucun
  limiteur dédié) :
  1. `POST /track-interaction` (`:141`) : validation correcte
     (enum fermée `validInteractionTypes`, scope `req.user.id`) — sain sur
     l'angle validation, mais toujours sans rôle (impact faible, écrit une
     seule ligne de tracking).
  2. `POST /cleanup-cache` (`:475`) : vide deux caches en mémoire — même
     motif déjà noté « mineur, non publié séparément » pour
     `advancedAdRoutes.js POST /cleanup-cache` (dégradation de perf
     partagée, pas de charge DB).
  3. `POST /add-tweet` (`:505`) et `PUT /update-tweet` (`:540`) : un seul
     `tweetId` non validé au-delà de sa présence, appelle
     `recommendationEngine.addNewTweet`/`updateTweet` — impact limité à un
     seul tweet par appel, pas de charge disproportionnée en soi.
  4. **`POST /reload-cache` (`:575`) →
     `recommendationEngine.loadCachedData()`
     (`src/services/progressiveRecommendationEngine.js:348-372`) : charge
     jusqu'à 500 tweets récents (`Tweet.findAll`, `limit: 500`), puis pour
     CHAQUE tweet, en séquence (boucle `for...of`, deux `await` par
     itération) : `determineTweetRecommendationGroup` (lecture/calcul) puis
     `updateTweetRecommendationGroup` (écriture DB). Soit jusqu'à ~1000
     requêtes séquentielles déclenchées par un seul appel HTTP.**
  5. **`POST /tag-all-tweets` (`:630-661`) : même motif, en pire — charge
     jusqu'à 1000 tweets non tagués (`Tweet.findAll`, `limit: 1000`,
     commentaire du code `// Limiter pour éviter la surcharge` — le plafond
     existe mais reste élevé), puis boucle séquentielle identique
     (`determineTweetRecommendationGroup` +
     `updateTweetRecommendationGroup` par tweet) : jusqu'à ~2000 requêtes
     séquentielles par appel.**
  6. `GET /cache-status` (`:602`) : lecture seule, aucun impact.
  **Effet concret :** un compte authentifié quelconque (pas de rôle requis)
  peut appeler `/reload-cache` ou `/tag-all-tweets` en boucle — seul frein,
  le quota global de `server.js:279` (1000 req/15 min), lui-même
  contournable par l'usurpation de statut first-party déjà documentée
  (constat moyen 1/4 de cette section) — et faire exécuter à chaque appel
  jusqu'à ~2000 requêtes DB séquentielles, sans qu'aucune de ces routes ne
  serve un usage utilisateur normal (ce sont des routes d'opération interne,
  pas des routes produit). C'est un vecteur de charge disproportionnée
  (DoS applicatif faible-coût), pas une fuite de données ni un gain
  économique — d'où le classement moyen et non critique/élevé, mais le
  ratio 1 requête HTTP → jusqu'à 2000 requêtes DB en fait un vecteur
  d'amplification notable. Correctif à transmettre : `requireAdmin` (ou
  rôle équivalent) sur les 5 routes de mutation de ce fichier ; paralléliser
  ou traiter par lot le rechargement/retaguage plutôt qu'une boucle
  séquentielle stricte ; ajouter un `rateLimiter` dédié, sévère, sur
  `/reload-cache` et `/tag-all-tweets` spécifiquement.
  **NE PAS refaire cette recherche.**

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `functionalEventRoutes.js` (5/5
  candidats).** Les 5 routes de mutation (`createEvent`, `updateEvent`,
  `activateEvent`, `deactivateEvent`, `deleteEvent`,
  `initialize-defaults`) sont **toutes** derrière `requireAdmin` (vérifié
  route par route, aucune exception). `createEvent`/`updateEvent`
  transmettent le corps de requête tel quel au service (assignation de
  masse potentielle), mais contrairement au constat critique 5/5
  (`adRoutes.js`, accessible à tout utilisateur authentifié), l'accès est
  déjà restreint aux administrateurs — surface de risque très réduite
  (opérateur déjà pleinement privilégié), pas retenu comme constat
  distinct. **Aucun constat.**

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `creatorIntelligenceRoutes.js`
  (5/5 candidats).** Toutes les routes derrière `requirePremium`/
  `requirePro`. `POST /generator` : système de crédits entièrement
  server-side (`reserveCredit`/`refundCredit` dans
  `customTweetGenerationService.js`, aucune valeur de crédit acceptée du
  client), texte utilisateur borné en longueur avant tout appel au modèle
  de génération. `POST /predict`, `POST /radar/idea`,
  `POST /copilot/suggest`, `POST /copilot/review` : contenu utilisateur
  toujours scopé à `req.user.id`, aucune valeur numérique/économique
  acceptée du client. **Aucun constat.**

- **S3 — CONSTAT MOYEN (5/5), déjà écrit, NE PAS REFAIRE :
  `src/routes/neuralRankRoutes.js:699` `POST /on-publish` — invalidation
  globale de caches Redis partagés, déclenchable par n'importe quel compte
  authentifié, sans lien vérifié avec une réelle publication.** Vérifié :
  la route lit seulement `tweetId` du corps (`:701`), **ne vérifie jamais
  que ce tweet existe ni qu'il appartient à l'appelant**, puis (`:711-720`)
  exécute pour CHACUN des 3 motifs (`twitninf:reco:*:trending`,
  `*:discover`, `*:for_you`) un `rc.keys(pattern)` suivi d'un `rc.del(keys)`
  sur l'ensemble de l'espace de clés Redis correspondant à **tous les
  utilisateurs de la plateforme**, pas seulement l'appelant. `KEYS` est une
  commande Redis bloquante en O(N) sur la taille totale du keyspace
  (documenté comme tel par Redis lui-même) — vérifié qu'aucune alternative
  non bloquante (`SCAN`) n'est utilisée ici. Aucun rôle requis au-delà de
  `authenticateToken` (confirmé, pas de middleware supplémentaire sur cette
  route ni englobant — `server.js:546`,
  `app.use('/api/neural-rank', neuralRankRoutes)`, sans limiteur dédié).
  **Effet concret :** un compte authentifié quelconque peut appeler cette
  route en boucle avec un `tweetId` arbitraire (même inexistant) et forcer,
  à chaque appel, un balayage bloquant de tout le keyspace Redis suivi de
  la suppression en masse des caches de recommandation de **tous les
  utilisateurs** — dégradation de performance partagée (chaque fil devra
  être recalculé au prochain accès) et charge Redis disproportionnée par
  rapport à un utilisateur légitime qui vient de publier un seul tweet.
  Pas de fuite de données ni de gain économique — classé moyen, dans la
  même famille que le constat moyen 4/4 (module de maintenance sans rôle ni
  limite de débit), mais ici le vecteur est Redis/`KEYS` plutôt que des
  requêtes SQL séquentielles. Correctif à transmettre : vérifier que
  `tweetId` existe et appartient à `req.user.id` avant toute invalidation ;
  remplacer `KEYS` par `SCAN` (non bloquant) ; envisager un débit dédié ou
  un appel interne (déclenché par le serveur lors de la publication
  elle-même) plutôt qu'une route publique séparée que le client doit
  penser à appeler.
  **NE PAS refaire cette recherche.**

- **S3 — `neuralRankRoutes.js` TERMINÉ (4/4 candidats bruts), reste sain
  hormis le constat ci-dessus.** `POST /track` : enum fermée
  (`typeMap`), scope `req.user.id`, valeurs numériques toutes passées par
  `Number.isFinite`/bornées avant transmission au moteur Rust.
  `POST /calibration/round` : `round` borné entier 1-10, tableaux convertis
  en chaînes, scope `req.user.id`. `POST /calibration/finish` : même scope,
  n'écrit aucun like public (commentaire du code vérifié cohérent avec le
  comportement — aucun appel à un service de like trouvé dans ce handler).

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `supportRoutes.js` (4/4
  candidats).** `POST /tickets` : sujet/message bornés en longueur, plafond
  de tickets ouverts appliqué (compté en base, pas déclaratif), catégorie
  restreinte à une liste fermée. `POST /tickets/:id/messages` : appartenance
  vérifiée (`ticket.user_id === actor.id` ou staff), `is_staff`/`is_internal`
  dérivés du rôle vérifié en base (`resolveSupportActor`), **jamais** du
  corps de requête malgré la présence de `req.body?.asStaff` — ce champ ne
  fait qu'activer le mode staff pour un membre du staff qui répond dans son
  propre ticket, il ne peut pas faire passer un non-staff pour staff (vérifié
  : `actingAsStaff = staff && (...)`, `staff` vient de `actor.isStaff`, pas
  du corps). Plafond de messages par fil appliqué. `POST /tickets/:id/close` :
  même vérification d'appartenance. `PATCH /admin/tickets/:id` : derrière
  `requireModeratorRole`, `status` restreint à une énumération fermée,
  `assigned_to` seulement assignable à soi-même ou nul (`assignToMe`
  booléen, pas d'ID arbitraire acceptable) — pas d'assignation de masse.
  **Aucun constat.**

- **S3 — CONSTAT CRITIQUE (8/8), déjà écrit, NE PAS REFAIRE :
  `src/routes/tweetRoutes.js:3290` `POST /api/tweets/views/increment` —
  compteur de vues librement incrémenté par le client, sans lien avec une
  vue réelle, qui alimente directement le calcul de récompense du module
  de monétisation.** Chaîne vérifiée de bout en bout :
  1. La route valide seulement que `tweetIds` est un tableau de 1 à 50
     UUID (`:3291-3293`) — **aucune vérification qu'une vue a réellement eu
     lieu** (pas de watch-time minimal, pas de déduplication par
     utilisateur, pas de cooldown). Elle ne vérifie pas non plus que
     l'appelant est l'auteur du tweet — n'importe quel tweet public
     convient (`is_private: false`, `:3306`), donc l'abus fonctionne aussi
     bien sur ses propres tweets que, avec moins d'intérêt direct, sur ceux
     d'un tiers.
  2. `Tweet.update({ view_count: sequelize.literal('view_count + 1') },
     { where: { id: { [Op.in]: validTweetIds } } })` (`:3321-3328`) —
     incrémentation inconditionnelle, un appel = +1 par tweet ciblé, répétable
     sans aucune limite au-delà du débit HTTP.
  3. **`src/services/tweetMonetizationService.js:136` et `:358`** : les deux
     chemins de calcul de récompense qui existent dans ce service —
     `calculateTweetEligibility` (aperçu, appelé aussi par le chemin direct
     déjà documenté en constat critique 6/6) ET **`processEligibleTweets`,
     le chemin AUTOMATISÉ qui remet les compteurs à zéro après paiement et
     que le constat 6/6 citait justement comme la référence saine** — lisent
     tous deux `tweet.view_count` en base et le multiplient par
     `currentRates.VIEWS` (`:71`, `0.01 TWC/vue` pour un tweet classique) pour
     composer le montant réellement versé (`distributeReward`,
     `:393` → grand livre). **Le chemin automatisé, jusqu'ici tenu pour sain
     dans cette section, verse donc lui aussi sur la foi d'un compteur que le
     client contrôle entièrement.**
  4. Limite en place : `tweetLimiter` (`server.js:319-330`, monté sur tout
     `/api/tweets`) plafonne à 200 requêtes/15 min pour le trafic non
     first-party — donc jusqu'à 200 incréments/15 min par tweet ciblé en
     boucle, soit 2 TWC/15 min par tweet au tarif de base, **sans plafond
     dans le temps** (répétable indéfiniment, 24h/24) — et cette limite
     elle-même est contournable par l'usurpation de statut first-party déjà
     documentée (constat moyen 1/5), auquel cas **aucune limite HTTP** ne
     s'applique.
  **Effet concret :** un compte monétisable (abonnement + programme
  accepté, cf. constat 6/6) peut gonfler indéfiniment le compteur de vues de
  son propre tweet en appelant cette route en boucle, puis déclencher le
  versement via le chemin automatisé normal (`process-all` /
  `processEligibleTweets`) — un versement réel en TWC, à partir d'une
  activité entièrement fabriquée, **sans passer par aucune des failles déjà
  documentées du chemin direct (6/6)**. C'est indépendant de ce constat :
  même si 6/6 était corrigé (bénéficiaire dérivé de l'auteur réel, compteurs
  remis à zéro), cette route resterait un moyen de payer le module de
  monétisation avec de fausses vues. Correctif à transmettre : ne
  jamais incrémenter `view_count` sur simple déclaration du client ;
  dériver la vue d'un signal server-side vérifiable (temps de lecture
  minimal côté client mais recoupé, unicité par utilisateur/tweet/fenêtre de
  temps stockée en base plutôt qu'un compteur nu), et à défaut plafonner
  strictement le nombre de vues comptées par utilisateur unique par tweet.
  **NE PAS refaire cette recherche.**

- **S3 — `tweetRoutes.js` — reste des candidats examinés à ce stade :**
  `POST /:id/super-like` vérifié sain (transaction + verrou de ligne,
  quota `super_hearts_remaining` entièrement server-side, aucune valeur
  numérique acceptée du client). Routes restantes du fichier
  (`/translations/batch`, `/:id/bookmark`, `/:id/share`, `POST /`,
  `PUT /:id`, `DELETE /:id`, `/:id/like`, `/:id/retweet`) **pas encore
  vérifiées sous l'angle validation** — à couvrir avant de considérer le
  fichier clos pour S3 (l'upload vidéo, `POST /video`, est déjà couvert en
  détail comme constat moyen séparé).

- **S3 — prochain pas concret :** finir `tweetRoutes.js` (routes listées
  juste au-dessus), puis reste de la liste régénérée
  (`nfMapRoutes.js`, `featureProposalRoutes.js`,
  `policierCongoAdminRoutes.js`, `contestRoutes.js`,
  `aiRecommendationRoutes.js`, `userSimilarityRoutes.js` — sous l'angle
  validation cette fois —, `developerAdminRoutes.js`,
  `shadowbanAdminRoutes.js`). Ordre par nombre de candidats bruts décroissant.

- **S3 — VÉRIFIÉ, SAIN — NE PAS REFAIRE. `events.js` + `eventQuestService.js`
  (8/8 candidats).** Module particulièrement soigné (commentaires défensifs
  explicites tout au long du service, rares ailleurs dans le dépôt).
  `claim(userId, questId)` : progression recalculée côté serveur
  (`measureAll`), complétion et prérequis revérifiés à la remise (pas
  seulement affichés), contrainte unique en base empêchant une double
  réclamation même en cas de course concurrente, récompense entièrement
  définie par la configuration serveur de la quête — **aucune valeur
  numérique acceptée du client à aucune étape**. L'octroi passe par
  `EconomyLedger.rewardFromTreasury` (même garde que le reste du grand
  livre), et le commentaire du code documente explicitement pourquoi ce
  choix rend la dérive de masse monétaire impossible (la trésorerie refuse
  si elle est à sec). `reportSignal` : enregistre uniquement un
  identifiant d'idempotence fourni par le client, sans aucune valeur de
  progression — la remise réelle ne s'appuie jamais sur le nombre de
  signaux envoyés sans re-vérification. Routes admin (création/modif/
  activation/suppression d'événement) toutes derrière `requireAdmin`.
  **Aucun constat.**

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
