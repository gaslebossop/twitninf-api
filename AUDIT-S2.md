# AUDIT S2 — Sécurité : autorisation et IDOR

> ⚠️ **Section `S*` — dépôt public.** Ce fichier ne publie que le **décompte et
> la gravité**. Aucun chemin exact, aucune méthode d'exploitation n'y figure.
> Le détail est transmis au propriétaire hors dépôt.

## ⏳ Section EN COURS — décompte partiel

Cette section n'est **pas terminée**. Le décompte ci-dessous porte sur la
partie déjà couverte ; il augmentera. L'état de reprise est tenu à jour dans
`AUDIT-PROGRESS.md`.

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

## Décompte partiel

| Gravité | Nombre de constats | Nature |
|---|---|---|
| **Critique** | **1** | Élévation de privilèges : une permission d'administration limitée permet d'accorder n'importe quel rôle, y compris le plus élevé du système, sans plafond |
| **Élevée** | **2** | Absence totale de contrôle d'appartenance sur tout un routeur (IDOR généralisé) ; route d'administration accessible sans authentification, avec effet de déni de service |
| Moyenne | 1 | Exposition de données dérivées d'un utilisateur arbitraire, sans authentification |
| Faible | 1 | Exposition d'informations internes de fonctionnement |

**À ce stade : 5 constats, dont 1 critique et 2 de gravité élevée.** Trois d'entre eux sont
**concentrés sur un seul et même fichier de routes** (constats « userSimilarity »),
qui n'a manifestement jamais reçu de contrôle d'accès — ce qui rend leur
correction simple : une seule ligne de middleware les traite d'un coup. Le
quatrième touche un **routeur entier de dix-neuf routes** dédié à la
publicité avancée : chaque route y vérifie qu'un jeton valide existe, mais
aucune ne vérifie que la ressource demandée (une publicité, une campagne, un
test A/B) appartient bien à l'appelant — c'est la définition même de l'IDOR,
mais appliquée systématiquement plutôt qu'à un point isolé. Le routeur
« classique » de publicité, à titre de comparaison, fait ce contrôle
correctement sur chacune de ses routes ; celui-ci ne le fait sur aucune.

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

Le détail des 3 constats est transmis au propriétaire hors dépôt. La
poursuite de la section — parcours route par route des routeurs
d'administration, de modération et d'économie — est décrite dans
`AUDIT-PROGRESS.md`.
