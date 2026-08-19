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

- **Section en cours :** S2 — autorisation et IDOR. **PARTIELLE, 5 constats,
  dont 1 CRITIQUE.**
- **Couvert :** R1 (10 constats), R2 (12), R3 (11), R4 (9), B1 (8), B2 (9),
  S1 (4) — **R1 à S1 TERMINÉES**. S2 en cours.

- **S2 — déjà fait, NE PAS REFAIRE :**
  1. **Recensement automatisé complet des routes sans authentification** sur
     tout `src/routes/`, en tenant compte des trois formes de protection du
     dépôt : middleware par route, `router.use(...)` global en tête de fichier,
     et **alias local** (ex. `const guard = [authenticateToken, ...]` dans
     `nfMapRoutes.js:27`). ⚠️ Un balayage naïf donne ~74 faux positifs ; après
     prise en compte des trois formes il reste 52 routes, dont la très grande
     majorité sont **légitimement publiques**.
  2. **Balayage IDOR** : chargements par identifiant client suivis d'une
     écriture, dans `src/routes/` et `src/controllers/`. **Aucun manquement
     trouvé** — les contrôles d'appartenance sont systématiquement présents.
  3. **Vérifiés et SAINS** (ne pas réexaminer) : `infrastructureInternalRoutes`
     (secret partagé, comparaison à temps constant, 404 au lieu de 401) ;
     `eventPassRoutes` `/verify` et `/redeem` (middleware `doorAccess`) ;
     `featureProposalRoutes` routes `/agent/*` (jeton dédié + limiteur) ;
     `contestRoutes:388` `/cancel` (`creator_id !== req.user.id`) ;
     `supportRoutes:431` `/tickets/:id/close` (`ticket.user_id` vs acteur, avec
     exception personnel) ; `nfMapRoutes` `/me`, `/position`, `/nearby`,
     `/friends`, `/invite` (tous derrière `guard`) ; `monetizationRoutes` et
     `tweetMonetizationRoutes` (`router.use(authMiddleware.authenticateToken)`).

- **S2 — 3 constats dans `src/routes/userSimilarityRoutes.js`**,
  fichier qui n'importe `authenticateToken` que pour ne jamais s'en servir.
  Détail transmis au propriétaire ; ne pas le publier dans `AUDIT-S2.md`.

- **S2 — 1 constat (élevé) dans `src/routes/advancedAdRoutes.js`, routeur
  ENTIER (19 routes).** Chaque route vérifie `authenticateToken` (n'importe
  quel utilisateur connecté) mais **aucune** ne vérifie que la publicité, la
  campagne ou le test A/B demandé appartient à l'appelant — pas de
  `where: { ..., user_id: userId }` nulle part dans ce fichier, alors que
  `src/routes/adRoutes.js` (le routeur « classique », déjà vérifié sain) le
  fait systématiquement. `Advertisement` porte bien une colonne `user_id`
  (vérifié dans `src/models/Advertisement.js`), donc le contrôle est
  possible, il est juste absent ici. Vérifié : `/export-data` (`:93`),
  `/score/:advertisementId` (`:132`), `/scores/all` (`:158`, aucun filtre —
  liste TOUTES les publicités actives), `/predict-performance` (`:186`),
  `/ab-test/create` (`:257`), `/ab-test/:testId/finalize` (`:363`),
  `/analytics/:advertisementId` (`:437`), `/analytics/global/summary`
  (`:489`, résumé de toute la plateforme pub, pas seulement de l'appelant).
  **NE PAS refaire cette vérification** — c'est fait, c'est confirmé, détail
  transmis au propriétaire.

- **S2 — déjà vérifiés dans cette reprise (sains, contrôle de rôle correct
  en tête de fichier) :** `shadowbanAdminRoutes.js` (`authenticateToken` +
  `requireAdminRole` globaux) ; `infrastructureAdminRoutes.js` (rôle
  re-vérifié en base à chaque requête, avec secours JWT documenté et limité
  au cas où la base est indisponible — bonne conception, jetée aux
  `execFile`/`spawn` de gestion d'infrastructure) ; `developerAdminRoutes.js`
  (pas de rôle admin, mais c'est voulu : chaque route filtre par
  `user_id: req.user.id`, c'est un espace développeur personnel, pas une
  administration globale).

- **S2 — CONSTAT CRITIQUE, `moderationController.js:2873` `promoteModerator`
  (routé par `POST /moderators/:userId/promote`, `moderationRoutes.js:476`,
  derrière `requirePermission('can_manage_moderators')`).** La fonction
  accepte n'importe quel `role` de la liste `['moderateur', 'admin',
  'superadmin', 'classeurdetweets', 'economiegardien']` envoyé dans le corps,
  **sans jamais comparer au rôle de l'appelant**. Aucun concept de hiérarchie
  de rôles n'existe ailleurs dans le dépôt (recherché : `hierarchy`,
  `ROLE_HIERARCHY`, `role_rank` — zéro résultat). `requirePermission` accorde
  un accès total dès que `moderation_permissions.can_manage_moderators` est
  vrai (`authMiddleware.js:538-545`) — cette permission est censée servir à
  gérer des modérateurs, pas à créer des superadmins. Résultat : **quiconque
  détient `can_manage_moderators` peut se promouvoir, ou promouvoir n'importe
  qui, `superadmin`**, ce qui accorde immédiatement `can_manage_moderators`,
  `can_manage_economy`, `can_ban_users`, etc. sans plafond (bloc
  `Object.assign` à `:2899-2909`). C'est une élévation verticale à partir d'une
  permission horizontale. Le routeur de modération est par ailleurs bien conçu
  (permissions nommées précises par action, config réservée au rôle le plus
  haut) — c'est le seul trou dans un dispositif sinon solide.
  **Note de code annexe, non un constat de sécurité en soi :** `promoteModerator`
  est défini deux fois dans la classe (`:2553`, un bouchon « à implémenter », et
  `:2873`, la vraie implémentation) — en JS, la seconde définition écrase la
  première silencieusement, donc c'est bien `:2873` qui s'exécute. À signaler
  au propriétaire comme signe qu'une relecture du fichier s'impose.
  Correctif à transmettre : exiger explicitement le rôle `superadmin` de
  l'appelant (ou un rang strictement supérieur au rôle cible) avant d'accorder
  `role: 'superadmin'` ou `role: 'admin'`, distinct du simple
  `can_manage_moderators`.

- **S2 — reprendre à :** `newEconomyController` (routes économiques —
  vérifier qu'un client ne peut pas influencer un montant, et vérifier que
  les rôles économiques comme `economiegardien` n'ont pas le même défaut de
  plafond que `promoteModerator` ci-dessus). Puis les deux pistes héritées :
  `src/models/Tweet.js:498` (défaut de la colonne `metadata`) croisé avec
  l'absence de liste blanche de sortie dans le fil (`src/routes/tweetRoutes.js:568`),
  et `src/routes/messageRoutes.js:59` (`requireGroupManagementRights` évalué
  hors transaction — constat B1-04).

- **PISTE POUR S3 (ne pas publier le détail) :** `src/server.js:279`, la
  fonction `skip` du limiteur de débit global — `isTrustedFirstPartyClient(req)`
  désactive **entièrement** le quota. Vérifier si un client peut se faire passer
  pour first-party. Et la fenêtre de 15 secondes de
  `transaction_risk_authorizations` (constat B1-02) : une autorisation validée
  survit à l'annulation de la transaction qui l'a demandée.

- **Reste :** S2 (en cours, partielle), S3.

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
