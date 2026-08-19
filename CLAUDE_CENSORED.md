# twitninf-api — Conventions (version publique)

Ce repo est **public** : ce fichier ne contient volontairement aucune IP,
aucun identifiant SSH, aucun secret. Le `CLAUDE.md` complet (accès VPS,
déploiement) existe mais reste local, jamais commité — c'est l'exception
prévue par `.gitignore` (`*.md` exclu par défaut). Une routine automatisée
n'a de toute façon aucun accès VPS depuis son environnement : elle code et
ouvre une PR, un humain déploie séparément.

## Stack

Node.js / Express, Sequelize / PostgreSQL, Redis. Structure : `src/routes/`
(déclaration des routes + validation `express-validator`), `src/controllers/`
(orchestration, gestion d'erreurs HTTP), `src/services/` (logique métier,
appelée par les controllers), `src/models/` (Sequelize).

Toujours regarder une route/controller/service existant traitant un cas
similaire avant d'en écrire un nouveau — les conventions de forme de réponse
(`{ success, message, data }` ou `{ success, ...}`), de gestion d'erreurs, et
de validation sont cohérentes dans tout le repo.

## Carte des routes — préfixe → fichier

Chaque préfixe est monté dans `src/server.js` sur le fichier de
`src/routes/` du même nom. Vérifier là avant de grep-explorer : c'est
souvent le seul fichier à ouvrir pour situer un endpoint existant.

| Préfixe | Fichier | Domaine |
|---|---|---|
| `/api/auth` | `authRoutes.js` | login/register/profil/session (voir aussi `authController.js` + `authService.js`) |
| `/api/tweets` | `tweetRoutes.js` | tweets |
| `/api/users` | `userRoutes.js` | profils publics, follow, recherche d'utilisateurs |
| `/api/search` | `searchRoutes.js` | recherche |
| `/api/notifications` | `notificationRoutes.js` | notifications |
| `/api/messages` | `messageRoutes.js` | messagerie |
| `/api/stories` | `storyRoutes.js` | stories |
| `/api/spotlight` | `spotlightRoutes.js` | mise en avant |
| `/api/moderation` | `moderationRoutes.js` | modération (voir aussi `moderationController.js`, qui contient plusieurs méthodes dupliquées — vérifier laquelle est vraiment appelée avant d'éditer) |
| `/api/community-moderation` | `communityModerationRoutes.js` | signalements communautaires |
| `/api/recommendations` | `recommendationRoutes.js` | recommandation legacy |
| `/api/neural-rank` | `neuralRankRoutes.js` | recommandeur NeuralRank |
| `/api/behavior` | `behaviorRoutes.js` | tracking comportemental |
| `/api/monetization`, `/api/monetization-program`, `/api/tweet-monetization` | `monetizationRoutes.js`, `monetizationProgramRoutes.js`, `tweetMonetizationRoutes.js` | monétisation créateurs |
| `/api/virtual-currency`, `/api/currencies` | `virtualCurrencyRoutes.js`, `userCurrencyRoutes.js` | monnaies (NF = monnaie système, voir `VirtualCurrency` model) |
| `/api/new-economy` | `newEconomyRoutes.js` | grand livre / transferts NF |
| `/api/wallet` | `walletRoutes.js` | portefeuille utilisateur |
| `/api/payments` | `paymentRoutes.js` | paiements réels (hors NF) |
| `/api/casino` | `casinoRoutes.js` | mini-jeux NF |
| `/api/events`, `/api/functional-events` | `events/`, `functionalEventRoutes.js` | événements saisonniers / fonctionnels |
| `/api/feature-flags` | `featureFlagRoutes.js` | feature flags (rollout progressif) |
| `/api/forge` | `featureProposalRoutes.js` | La Forge — c'est ce fichier que la routine elle-même modifie si la tâche touche à la Forge |
| `/api/nf-map` | `nfMapRoutes.js` | carte NF (positions géo) |
| `/api/premium` | `premiumRoutes.js` | abonnement premium |
| `/api/support` | `supportRoutes.js` | tickets support |
| `/api/paid-content` | `paidContentRoutes.js` | contenu payant à l'unité |
| `/api/scheduled-tweets` | `scheduledTweetRoutes.js` | publication programmée |
| `/api/insights` | `insightsRoutes.js` | statistiques créateur |
| `/api/username-market` | `usernameMarketRoutes.js` | marché des pseudos |
| `/api/contests` | `contestRoutes.js` | concours |
| `/api/verification`, `/api/verified-badges`, `/api/verification-style` | fichiers homonymes | certification de compte |
| `/api/ads` | `adRoutes.js` | publicité |
| `/api/user-challenges` | `userChallengeRoutes.js` | défis utilisateur |
| `/api/inventory` | `inventoryRoutes.js` | objets/cosmétiques possédés |
| `/api/admin/*` | `economyAdminRoutes.js`, `similarityAdminRoutes.js`, `shadowbanAdminRoutes.js`, `developerAdminRoutes.js`, `infrastructureAdminRoutes.js` | panels admin — jamais le modèle de données brut, voir la règle UI admin ci-dessous |
| `/api/user-stats`, `/api/creator-intelligence`, `/api/track` | fichiers homonymes | analytics |
| `/api/legal` | `legalRoutes.js` | CGU/RGPD |

Pas dans ce tableau → `grep -rn "app.use('/api" src/server.js` liste tout.

## Un écran d'administration expose des décisions, pas le modèle

Si la tâche touche un panel admin : les options proposées à l'écran doivent
être des ACTIONS lisibles (« Construite — verser la récompense »), jamais les
valeurs brutes de l'ENUM serveur (`built`) ni les noms de colonnes. Voir
`featureProposalRoutes.js`/`forgeService.ts` (`DECISIONS`) comme référence
de ce patron déjà appliqué.

## Piège n°1 — une colonne ajoutée à un modèle n'atteint jamais la base seule

Le démarrage du serveur (`src/models/index.js`, fonction `syncDatabase`)
appelle `sequelize.sync({ force: false, alter: false })`. **`alter: false`
signifie que Sequelize ne modifie JAMAIS une table déjà existante** — il crée
uniquement les tables manquantes.

Conséquence directe : ajouter un champ à un modèle Sequelize existant (`bio:
{...}` → `city: {...}` sur `User` par exemple) ne crée PAS la colonne en
base. Le code plantera ou lira `undefined` silencieusement en production tant
que la colonne n'existe pas réellement.

**La solution déjà établie dans ce repo** (pas une migration classique) :
une fonction `ensureXColumn()` dans `src/models/index.js`, qui fait un
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` en SQL brut, appelée juste
avant `sequelize.sync()`. Voir les fonctions déjà existantes dans ce fichier
(`ensureUsersSubscriptionColumns`, `ensureUsersTweetGenerationCreditsColumn`,
`ensureUsersCityColumn`) et répliquer exactement ce patron pour toute
colonne ajoutée à une table PRÉEXISTANTE (`users` en particulier — table la
plus modifiée et la plus contrainte par des vues dépendantes).

Une TABLE entièrement nouvelle n'a pas ce problème : `sync({alter:false})`
crée bien les tables manquantes. Dans ce cas, ajouter un fichier de
migration classique dans `src/migrations/` (voir les fichiers existants,
`queryInterface.createTable`) suffit, sans fonction `ensureX`.

## Vérifier avant de push

```bash
node --check <fichier>     # syntaxe, rapide, un par fichier touché
npm test                   # jest — lancer au moins les specs du dossier touché
```

`npm test` seul lance TOUTE la suite ; pour une itération rapide sur un
sous-ensemble, `npx jest <chemin>`.
