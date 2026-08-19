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
| R1 | Rapidité | Requêtes N+1 | À FAIRE | `AUDIT-R1.md` |
| R2 | Rapidité | Index et requêtes lentes | À FAIRE | `AUDIT-R2.md` |
| R3 | Rapidité | Pagination et taille des réponses | À FAIRE | `AUDIT-R3.md` |
| R4 | Rapidité | Travail bloquant (boucle d'événements) | À FAIRE | `AUDIT-R4.md` |
| B1 | Robustesse | Verrous et concurrence | À FAIRE | `AUDIT-B1.md` |
| B2 | Robustesse | Erreurs et journaux | À FAIRE | `AUDIT-B2.md` |
| S1 | Sécurité | Secrets dans l'historique git | À FAIRE | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## Règles de la routine

- Traiter la **première section À FAIRE**, et elle seule.
- À la fin d'une section : écrire `AUDIT-<CODE>.md`, passer la ligne à
  `TERMINÉE`, committer et pousser sur `audit/rapport` immédiatement.
- Ne jamais pousser sur la branche par défaut. Aucune pull request.
- Aucun fichier source n'est modifié : on observe et on rapporte.
- Quand tout est TERMINÉ : écrire `AUDIT TERMINÉ` en première ligne de ce
  fichier et signaler que la routine peut être désactivée.
