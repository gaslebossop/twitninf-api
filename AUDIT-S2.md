# AUDIT S2 — Sécurité : autorisation et IDOR

> ⚠️ **Section `S*` — dépôt public.** Ce fichier ne publie que le **décompte et
> la gravité**. Aucun chemin exact, aucune méthode d'exploitation n'y figure.
> Le détail est transmis au propriétaire hors dépôt.

## ⚠️ Section TERMINÉE, ROUVERTE PONCTUELLEMENT — 1 constat ajouté

Un constat supplémentaire a été trouvé après la clôture de cette section,
en examinant `userRoutes.js` sous l'angle de la section S3 (validation).
Il s'agit sans ambiguïté d'un constat S2 (contrôle de rôle absent), pas
S3 : il est donc ajouté ici plutôt que dans `AUDIT-S3.md`. Voir le décompte
mis à jour ci-dessous et l'entrée dans `AUDIT-PROGRESS.md`. Le reste de la
section reste acquis tel quel, rien d'autre n'a été réexaminé.

## Méthode

Deux balayages complémentaires, tous deux menés sur l'intégralité de
`src/routes/` et `src/controllers/` :

1. **Routes sans authentification.** Recensement automatisé de toutes les
   routes déclarées, en tenant compte des trois formes de protection
   employées dans ce dépôt : middleware posé route par route, middleware posé
   globalement en tête de routeur, et alias local regroupant plusieurs
   middlewares. Chaque route restante a ensuite été examinée à la main pour
   distinguer celles qui sont **légitimement publiques** de celles qui ne
   devraient pas l'être.
2. **IDOR.** Recherche des chargements de ressource par identifiant fourni par
   le client suivis d'une écriture, puis vérification à la main de la présence
   d'un contrôle d'appartenance.

## Décompte final

| Gravité | Nombre de constats | Nature |
|---|---|---|
| **Critique** | **2** | Élévation de privilèges : une permission d'administration limitée permet d'accorder n'importe quel rôle, y compris le plus élevé du système, sans plafond ; un ensemble de routes de modération de compte (quatre actions, dont la plus destructrice du dépôt en matière d'intégrité de plateforme) ne porte **aucun contrôle de rôle** — seule l'authentification de base est exigée, alors qu'un routeur distinct du même dépôt fait ce contrôle correctement pour les mêmes actions |
| **Élevée** | **3** | Absence totale de contrôle d'appartenance sur tout un routeur (IDOR généralisé) ; route d'administration accessible sans authentification, avec effet de déni de service ; fuite de données personnelles d'un utilisateur vers tout autre utilisateur, dans une réponse à fort trafic |
| Moyenne | 1 | Exposition de données dérivées d'un utilisateur arbitraire, sans authentification |
| Faible | 1 | Exposition d'informations internes de fonctionnement |

**Au total : 7 constats, dont 2 critiques et 3 de gravité élevée.** Le nouveau
constat critique est, de tous les constats de cette section — et sans doute
de tout l'audit à ce stade — celui dont l'exploitation demande le moins de
conditions préalables : **aucun rôle, aucun abonnement, aucune éligibilité
particulière, juste un compte authentifié et non suspendu**, sur des actions
qui affectent n'importe quel autre compte de la plateforme, sans plafond ni
délai. Trois des six constats initiaux sont
**concentrés sur un seul et même fichier de routes** (constats « userSimilarity »),
qui n'a manifestement jamais reçu de contrôle d'accès — ce qui rend leur
correction simple : une seule ligne de middleware les traite d'un coup. Un
autre touche un **routeur entier de dix-neuf routes** dédié à la
publicité avancée : chaque route y vérifie qu'un jeton valide existe, mais
aucune ne vérifie que la ressource demandée (une publicité, une campagne, un
test A/B) appartient bien à l'appelant — c'est la définition même de l'IDOR,
mais appliquée systématiquement plutôt qu'à un point isolé. Le routeur
« classique » de publicité, à titre de comparaison, fait ce contrôle
correctement sur chacune de ses routes ; celui-ci ne le fait sur aucune.

Le constat critique et le constat de fuite de données touchent chacun un
point unique et précis — respectivement une fonction d'administration et une
construction de réponse — plutôt qu'un fichier entier ; leur correction est
elle aussi courte, mais leur effet est le plus large de la section : le
premier ouvre la voie à un contrôle total du système depuis un compte à
privilèges limités, le second expose une donnée personnelle sensible sur la
route la plus fréquentée de l'API, à chaque appel.

## Piste transmise à S3

En vérifiant le contrôle de rôle des routes économiques, une question a été
soulevée qui dépasse le périmètre de cette section : la route d'achat de
monnaie virtuelle mérite une vérification de bout en bout de la preuve de
paiement. Elle est traitée en priorité à l'ouverture de `AUDIT-S3.md`.

## Ce qui a été vérifié et trouvé sain — à ce stade

Cette liste importe autant que le décompte : la classe de faille annoncée
comme « la plus probable » sur ce dépôt s'est révélée, sur la partie déjà
couverte, **bien maîtrisée**.

- **Contrôles d'appartenance (IDOR) : aucun manquement trouvé pour l'instant.**
  Toutes les écritures examinées qui chargent une ressource depuis un
  identifiant fourni par le client vérifient bien l'appartenance avant de
  modifier quoi que ce soit, et renvoient un `403` explicite sinon. Les
  vérifications sont faites avec une comparaison de chaînes normalisée là où
  les types peuvent différer, ce qui évite le piège classique de la
  comparaison entre un identifiant numérique et sa représentation textuelle.
  Plusieurs de ces contrôles prévoient en outre une exception explicite pour
  le personnel, correctement séparée du cas propriétaire.
- **Protection par secret partagé entre services :** le routeur interne
  concerné compare le secret reçu avec une comparaison **à temps constant**,
  et répond `404` plutôt que `401` en cas d'échec — deux bons réflexes, l'un
  contre les attaques temporelles, l'autre contre la découverte de la surface
  interne. À conserver tel quel.
- **Routes d'accès physique à un événement :** protégées par un middleware
  dédié acceptant soit un jeton de porte valide, soit une authentification
  complète assortie d'un contrôle de rôle. La séparation entre l'appel qui
  *consulte* et l'appel qui *consomme* est explicite et commentée. Bonne
  conception.
- **Routes destinées à un agent automatisé :** protégées par un jeton dédié
  **et** un limiteur de débit propre. Le champ de la réponse est volontairement
  réduit au strict nécessaire, et le plafond de récompense est réappliqué côté
  serveur quelle que soit la valeur envoyée — le client n'est pas cru sur
  parole. Bonne conception.
- **Routes publiques légitimes :** pages légales, ressources statiques,
  tuiles et polices de la carte, inscription et connexion. Elles n'ont pas
  vocation à être authentifiées et ne sont pas comptées comme des constats.
- **Routeur de modération :** examiné en détail — c'est, avec un seul défaut
  près (voir le constat critique ci-dessus), le mieux protégé du dépôt. Chaque
  route sensible porte une permission nommée précise plutôt qu'un contrôle de
  rôle générique (`can_suspend_users`, `can_ban_users`, `can_verify_users`,
  `can_manage_moderators`…), et les routes de configuration globale exigent
  spécifiquement le rôle le plus élevé. C'est une bonne conception, à l'unique
  endroit près où elle n'a pas de plafond.

## Suite

Le détail complet des 6 constats — chemins exacts, méthode, correctif — est
transmis au propriétaire hors dépôt.
