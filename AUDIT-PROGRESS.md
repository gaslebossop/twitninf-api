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
| B2 | Robustesse | Erreurs et journaux | **EN COURS** | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | À FAIRE | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** B2 — erreurs et journaux.
- **Couvert :** R1 (10 constats), R2 (12), R3 (11), R4 (9), B1 (8) — **R1 à B1
  TERMINÉES**, chacune avec sa section « vérifié et trouvé sain » et son
  récapitulatif.
- **Prochain pas :** B2 démarrée. **2 constats écrits : B2-01** (Float32Array(256)
  vs DIMS=768 — bruit journaux + tweets média jamais vectorisés) et **B2-02**
  (prompt de vérification contenant l'identité écrit sur disque, jamais purgé,
  `temp/` non ignoré → 13 fichiers suivis dans un dépôt public — **CRITIQUE,
  propriétaire notifié**) et **B2-03** (`catch` vides : verdict de détection de
  bot jamais persisté ni journalisé en cas d'échec + recensement de tous les
  `catch` vides de `src/`, avec la liste de ceux jugés sains).
  **Le recensement des `catch` vides est FAIT, ne pas le refaire.**
  Continuer avec la piste 3 ci-dessous.

- **Pistes déjà repérées pour B2, à écrire en priorité :**
  1. ~~`recommendationEngine.js:711` `Float32Array(256)` vs `DIMS = 768`~~ →
     **écrit, constat B2-01.**
  2. ~~`verificationService.js:385` fichiers `temp/` jamais purgés~~ →
     **écrit, constat B2-02** (à reprendre côté S1 pour l'exposition publique).
  3. Les `catch` des appels réseau de R4-01 : un appel sans délai d'attente
     n'échoue jamais, donc son `catch` ne journalise jamais rien.
  4. `src/services/similarity/vectorEngine.js:394` `save()` n'est pas atomique
     (pas de `.tmp` + `rename`) : un redémarrage pendant l'écriture laisse un
     `.vdb` tronqué que `load()` (`:437`) relira.
  5. `console.log`/`console.error` bruts dans `similarity/` et `economy/`
     (au lieu de `logger`), à recenser.
  - Chercher ensuite : `catch {}` vides, `catch` qui répondent 200,
     données personnelles dans les journaux (croiser avec `metadata.ip_address`,
     cf. la piste S2 ci-dessous), et le volume de `logger.info` sur les chemins
     chauds.

- **PISTE POUR S2 (ne pas publier le détail) :** `src/models/Tweet.js:498`,
  valeur par défaut de la colonne `metadata`, croisée avec l'absence de liste
  blanche de sortie dans le fil (`src/routes/tweetRoutes.js:568`). Voir aussi
  `src/routes/messageRoutes.js:59` (`requireGroupManagementRights`, contrôle
  d'accès évalué hors transaction — constat B1-04).
- **PISTE POUR S3 (ne pas publier le détail) :** `src/server.js:279`, la
  fonction `skip` du limiteur de débit global. Et la fenêtre de 15 secondes de
  `transaction_risk_authorizations` (constat B1-02) : une autorisation validée
  survit à l'annulation de la transaction qui l'a demandée.

- **Reste :** B2 (en cours), S1, S2, S3.

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
