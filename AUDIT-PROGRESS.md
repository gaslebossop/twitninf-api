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
| R4 | Rapidité | Travail bloquant (boucle d'événements) | **EN COURS** | `AUDIT-R4.md` |
| B1 | Robustesse | Verrous et concurrence | À FAIRE | `AUDIT-B1.md` |
| B2 | Robustesse | Erreurs et journaux | À FAIRE | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | À FAIRE | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** R4 — travail bloquant (boucle d'événements).
- **Couvert :** R1 (10 constats), R2 (12 constats), R3 (11 constats + section
  « vérifié et trouvé sain » + récapitulatif) — **R3 TERMINÉE**.
- **Couvert pour R4 :** 3 constats écrits (R4-01 appels réseau sans délai
  d'attente — inventaire complet des 14 appels sortants de `src/`, 7 sans
  délai / 7 avec ; les appels de `src/scripts/test_*.js` sont des scripts de
  test hors production et ont été écartés ; R4-02 `bcryptjs` pur JS au coût 12,
  `src/models/User.js:2/8/651/661` — **mesuré** : 335 ms par hachage, retard
  max de la boucle d'événements 93 ms, ~90 % de capacité perdue pendant le
  calcul ; méthode de mesure reproductible décrite dans le constat ;
  R4-03 `similarity/vectorEngine.js:394` `writeFileSync` de ~300 Mo toutes les
  5 min dans le processus API — **mesuré** : 2,7 s de gel pour 100 k vecteurs,
  et `_periodicSave` en enchaîne deux).
- **Reprendre à :** `readFileSync`/`writeFileSync` sur chemins de requête —
  inventaire déjà fait, à trier (`similarity/vectorEngine.js:426/442` = fait,
  c'est R4-03) : `vectorStoreService.js:207/229/243/249` (même forme que R4-03
  mais en JSON, à chiffrer),
  `videoEditService.js:267`,
  `verificationService.js:385`, `nfMapWebView.js:680`,
  `policiercongo/schedulerManager.js:81/98`,
  `policiercongo/InstructionManager.js:105/123`, `tweetImageService.js:66`.
  (Vérifié SAIN : `searchSummaryService.js` — `ensureCacheLoaded` ne s'exécute
  qu'une fois via un drapeau, et `persistCache` utilise `fs.promises` avec une
  file d'écriture sérialisée. `bcrypt` = fait, c'est R4-02.) Ensuite :
  traitement d'image (`sharp`/HEIC — noter que `sharp` délègue à libvips hors
  fil principal, donc vérifier plutôt `heifDecoder.js` et les conversions
  synchrones), boucles sur gros tableaux dans les gestionnaires, et les
  `setImmediate` de `tweetRoutes.js` (1419, 1845, 2565) et
  `messageRoutes.js:1636`.
- **Pistes déjà repérées pour R4, à vérifier en premier :**
  `src/routes/tweetRoutes.js:1603` (diffusion des notifications sous
  `setImmediate`, cf. R3-07 : N `INSERT` séquentiels dans la boucle
  d'événements) ; les trois autres `setImmediate(async …)` de
  `tweetRoutes.js` (l. 1419, 1845, 2565) ; `src/routes/messageRoutes.js:1636`
  (`broadcastNewMessage` sous `setImmediate`). Chercher ensuite :
  `readFileSync`/`writeFileSync` dans les gestionnaires, traitement d'image
  (`sharp`, HEIC), `bcrypt` synchrone, `JSON.parse` sur gros volumes, et
  appels réseau sans délai d'attente (`fetch`/`axios` sans `timeout`).
- **Piste pour S2 (ne pas publier le détail) :** `src/models/Tweet.js:498`,
  valeur par défaut de la colonne `metadata`, croisée avec l'absence de liste
  blanche de sortie dans le fil (`src/routes/tweetRoutes.js:568`).
- **Reste :** R4 (en cours), B1, B2, S1, S2, S3.

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
