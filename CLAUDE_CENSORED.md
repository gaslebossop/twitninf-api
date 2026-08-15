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
