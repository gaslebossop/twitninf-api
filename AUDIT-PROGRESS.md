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
| S1 | Sécurité | Secrets dans l'historique git | **EN COURS** | `AUDIT-S1.md` |
| S2 | Sécurité | Autorisation et IDOR | À FAIRE | `AUDIT-S2.md` |
| S3 | Sécurité | Injection, validation, abus | À FAIRE | `AUDIT-S3.md` |

## REPRENDRE À

> Ligne de reprise, tenue à jour **après chaque constat**. La session peut
> s'interrompre sans préavis : cette ligne est le seul point de reprise fiable.

- **Section en cours :** S1 — secrets dans l'historique git.
- **Couvert :** R1 (10 constats), R2 (12), R3 (11), R4 (9), B1 (8), **B2 (9)** —
  **R1 à B2 TERMINÉES**, chacune avec sa section « vérifié et trouvé sain » et
  son récapitulatif.

- **B2 est TERMINÉE.** 9 constats, récapitulatif et ordre d'application écrits.
  Ne rien y reprendre. Le plus grave, **B2-02**, est une exposition publique de
  données personnelles **en cours** (fichiers `temp/` suivis par git) : le
  propriétaire a été notifié pendant la passe. À reprendre sous l'angle
  « historique git » en S1.

- **Prochain pas : démarrer S1.** Aucun constat S1 encore écrit.
  ⚠️ **Premier geste : `git add -f AUDIT-S1.md`** (voir la règle `.gitignore`
  plus bas), puis vérifier `git ls-files | grep AUDIT`.
  ⚠️ **RAPPEL DÉPÔT PUBLIC — S1 est une section `S*` :** dans `AUDIT-S1.md`,
  écrire **uniquement le décompte et la gravité**. Jamais le secret, jamais le
  chemin exact, jamais la méthode. Tout le détail va dans le MESSAGE FINAL.

- **Pistes déjà repérées pour S1 :**
  1. **Le plus sûr d'aboutir :** les 13 fichiers `temp/verification-prompt-*.txt`
     suivis par git (constat B2-02). Ce ne sont pas des secrets techniques mais
     des données personnelles d'utilisateurs réels, publiées. Établir en S1
     depuis quel commit ils sont présents (`git log --diff-filter=A -- temp/`)
     et confirmer qu'ils sont dans l'historique complet.
  2. Balayer l'historique complet : `git log -p --all`, puis
     `git log -S` ciblé sur les motifs habituels (`SECRET`, `API_KEY`,
     `PASSWORD`, `TOKEN`, `PRIVATE KEY`, `sk-`, `AKIA`, `.env`).
  3. Cibler les fichiers de configuration : `src/config/config.js` contient une
     configuration SMTP (`smtp.gmail.com`, vu en B2-07) — vérifier si un mot de
     passe d'application y a figuré à un moment.
  4. `internalSecret()` (`src/services/ctrTracker.js`) et `config.jwt.secret`
     (`src/services/authService.js:450`) : vérifier si une valeur par défaut en
     dur a existé dans l'historique.

- **Reste :** S1 (en cours), S2, S3.

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
