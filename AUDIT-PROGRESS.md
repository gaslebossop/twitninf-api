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
| R3 | Rapidité | Pagination et taille des réponses | **EN COURS** | `AUDIT-R3.md` |
| R4 | Rapidité | Travail bloquant (boucle d'événements) | À FAIRE | `AUDIT-R4.md` |
| B1 | Robustesse | Verrous et concurrence | À FAIRE | `AUDIT-B1.md` |
| B2 | Robustesse | Erreurs et journaux | À FAIRE | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | À FAIRE | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** R3 — pagination et taille des réponses.
- **Couvert :** R1 (10 constats), R2 (12 constats), R3 : 4 constats écrits
  (R3-01 `recommendationRoutes.js:264`, R3-02 `messageRoutes.js:489`,
  R3-03 `messageRoutes.js:517`, R3-04 `messageRoutes.js:1844`).
- **Déjà passé en revue pour R3 :** inventaire des 57 `findAll` sans `limit`
  dans `src/routes/` et `src/controllers/` (liste établie par balayage
  automatique — **attention, ce balayage rate les appels dont un `include`
  imbriqué contient un `limit` : `messageRoutes.js:517` n'y figurait pas alors
  qu'il est bien non paginé ; ne pas s'y fier seul**) ; vérification que `GET /api/tweets` **est** borné
  (`query('limit').isInt({max:100})`, `tweetRoutes.js:182`) et que
  `/api/recommendations` **est** borné (`Math.min(..., 10)`,
  `recommendationRoutes.js:528`) — ce ne sont donc pas des constats.
- **Reprendre à :** suite de l'inventaire des `findAll` sans `limit`, dans
  l'ordre : `messageRoutes.js` (458, 489, 834, 1231, 1243, 1480, 1636, 1844),
  `userRoutes.js` (406, 423, 631, 840-862), `storyRoutes.js` (141-773),
  `tweetRoutes.js` (335, 415, 590, 1603, 1609, 3302), puis
  `recommendationRoutes.js` (autres lignes), `moderationController.js`
  (2294-2326), `contestRoutes.js`, `adRoutes.js`, `supportRoutes.js`.
  Ensuite : `SELECT *` / attributs sur-sérialisés, et listes renvoyées
  entières (15 fichiers de routes lisent `req.query.limit` **sans**
  `query('limit')` de validation — liste à re-établir par grep).
- **Reste :** R3 (en cours), R4, B1, B2, S1, S2, S3.

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
