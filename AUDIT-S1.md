# AUDIT S1 — Sécurité : secrets dans l'historique git

> ⚠️ **Section `S*` — dépôt public.** Ce fichier ne publie que le **décompte et
> la gravité**. Aucune valeur de secret, aucun chemin exact, aucune méthode
> d'exploitation n'y figure. Le détail complet — quoi révoquer, où, dans quel
> ordre — a été transmis directement au propriétaire, hors dépôt.

## Principe retenu

Le dépôt est passé de privé à public. **Tout secret ayant existé dans
l'historique est compromis**, qu'il ait été supprimé depuis ou non : un dépôt
public est cloné, mis en cache et indexé, et un `force-push` ne dépublie rien.
La question n'est donc pas « le secret est-il encore là ? » mais « a-t-il été
là une fois ? ». Le décompte ci-dessous applique ce principe.

## État de l'audit S1

**Balayage effectué** sur l'intégralité de l'historique — 205 commits, toutes
branches et toutes références comprises. Motifs recherchés : clés de
fournisseurs cloud et d'IA, jetons de plateformes, clés privées, chaînes de
connexion à base de données et à cache, valeurs de repli codées en dur sur des
variables d'environnement sensibles, et fichiers d'environnement.

## Décompte

| Gravité | Nombre de constats | Nature |
|---|---|---|
| **Critique** | **3** | Identifiants de service à révoquer et faire tourner sans délai |
| **Élevée** | **1** | Identifiant d'infrastructure à faire tourner |
| Pour information | 1 | Point d'hygiène, sans secret exposé |

**Au total : 4 constats portant sur des secrets réellement compromis, dont 3
critiques.** Ils représentent **12 valeurs d'identifiants distinctes** à
révoquer.

### Précision aggravante

Sur les 4 constats, **2 ne sont pas seulement « dans l'historique » : les
valeurs concernées sont lisibles en l'état sur des branches actuellement
publiées sur le dépôt distant.** Il ne s'agit donc pas d'une exposition passée
à assainir, mais d'une exposition **en cours**. C'est ce qui fixe l'urgence :
la révocation est à faire maintenant, avant tout travail de réécriture
d'historique.

### Constat critique connexe, déjà documenté

Le constat **B2-02** (`AUDIT-B2.md`) relève d'une problématique voisine et
compte en plus des 4 ci-dessus : des **données personnelles d'utilisateurs
réels** — et non des secrets techniques — sont présentes dans des fichiers
suivis par git, dans ce dépôt public. La différence est importante pour le
plan d'action : **une donnée personnelle ne se révoque pas.** Là où un
identifiant compromis se remplace en quelques minutes, cette exposition-là ne
peut être traitée que par purge de l'historique, et les données déjà
moissonnées le restent.

## Ce qui a été vérifié et trouvé sain

- **Aucun fichier `.env` réel n'a jamais été commité.** Seul `.env.example`
  figure dans l'historique, et son contenu a été vérifié : il ne contient que
  des valeurs d'exemple explicitement marquées comme telles. C'est le
  comportement attendu.
- **Aucune clé privée** (RSA, EC, OpenSSH, PKCS#12) dans l'historique.
- **Aucun jeton de plateforme de développement** (jetons d'accès personnels
  GitHub, jetons de robot de messagerie d'équipe) dans l'historique.
- **Aucune clé de fournisseur cloud** de type AWS dans l'historique.
- **Aucune chaîne de connexion réelle** à une base de données ou à un cache :
  les seules occurrences trouvées sont des exemples de documentation utilisant
  des valeurs manifestement fictives.
- **Le code actuel est propre sur ce point.** Les valeurs de repli codées en
  dur qui posaient problème ont toutes été retirées depuis : la configuration
  lit désormais ses secrets depuis l'environnement, sans valeur de secours.
  Le défaut est entièrement historique — mais l'historique suffit à rendre les
  secrets inutilisables, d'où les constats ci-dessus.
- **Les valeurs codées en dur restant dans les fichiers de test** ont été
  examinées et écartées : elles sont explicitement réservées aux tests et sans
  valeur hors de ce contexte.

## Suite

Le plan de révocation détaillé — la liste « À RÉVOQUER MAINTENANT », l'ordre
des opérations et les points d'attention sur la réécriture d'historique — a
été transmis au propriétaire hors dépôt, conformément à la règle de
publication de cette section.
