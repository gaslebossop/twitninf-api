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
| S2 | Sécurité | Autorisation et IDOR | **EN COURS** | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** S2 — autorisation et IDOR.
- **Couvert :** R1 (10 constats), R2 (12), R3 (11), R4 (9), B1 (8), B2 (9),
  **S1 (4 constats + 1 pour information)** — **R1 à S1 TERMINÉES**.

- **S1 est TERMINÉE.** Balayage complet des 205 commits, toutes références.
  4 constats de secrets compromis (3 critiques), 12 valeurs d'identifiants à
  révoquer, **dont 2 constats encore lisibles sur des branches distantes
  publiées** — exposition EN COURS, pas seulement historique. Le propriétaire a
  été notifié avec le détail et la liste de révocation. `AUDIT-S1.md` ne
  contient que décompte et gravité (règle dépôt public). **Ne pas refaire ce
  balayage.**

- **Prochain pas : démarrer S2** (autorisation et IDOR). Aucun constat écrit.
  ⚠️ **Premier geste : `git add -f AUDIT-S2.md`**, puis vérifier
  `git ls-files | grep AUDIT`.
  ⚠️ **RAPPEL DÉPÔT PUBLIC — S2 est une section `S*` :** décompte et gravité
  seulement dans le fichier poussé. Le détail va dans le MESSAGE FINAL.

- **Pistes déjà repérées pour S2 :**
  1. `src/models/Tweet.js:498`, valeur par défaut de la colonne `metadata`,
     croisée avec l'absence de liste blanche de sortie dans le fil
     (`src/routes/tweetRoutes.js:568`).
  2. `src/routes/messageRoutes.js:59` (`requireGroupManagementRights`) :
     contrôle d'accès évalué hors transaction — voir constat B1-04.
  3. Méthode conseillée : parcours route par route des fichiers de
     `src/routes/`, en vérifiant pour chacune (a) la présence d'un middleware
     d'authentification, (b) le contrôle d'appartenance quand un identifiant
     vient du client, (c) le contrôle de rôle sur les routes d'administration,
     de modération et d'économie. Commencer par les routes d'administration et
     d'économie : `economyAdminController`, `shadowbanAdminRoutes`,
     `developerAdminRoutes`, `infrastructureAdminRoutes`, `moderationController`.

- **PISTE POUR S3 (ne pas publier le détail) :** `src/server.js:279`, la
  fonction `skip` du limiteur de débit global. Et la fenêtre de 15 secondes de
  `transaction_risk_authorizations` (constat B1-02) : une autorisation validée
  survit à l'annulation de la transaction qui l'a demandée.

- **Reste :** S2 (en cours), S3.

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
