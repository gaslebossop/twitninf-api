# AUDIT S3 — Sécurité : injection, validation, abus

> ⚠️ **Section `S*` — dépôt public.** Ce fichier ne publie que le **décompte et
> la gravité**. Aucun chemin exact, aucune méthode d'exploitation n'y figure.
> Le détail est transmis au propriétaire hors dépôt.

## ⏳ Section EN COURS — décompte partiel

Cette section n'est **pas terminée**. Le décompte ci-dessous porte sur la
partie déjà couverte ; il augmentera. L'état de reprise est tenu à jour dans
`AUDIT-PROGRESS.md`.

## Périmètre

SQL construit par concaténation (en particulier un nom de colonne venant
d'une entrée utilisateur — précédent connu sur ce dépôt), validation absente
sur les routes d'écriture, upload (type réel, taille, chemin), limitation de
débit sur connexion/inscription/mot de passe oublié, et logique économique :
un client peut-il influencer un montant ou rejouer une opération créditrice.

## Décompte partiel

| Gravité | Nombre de constats | Nature |
|---|---|---|
| **Critique** | **9** | Une opération créditrice peut être déclenchée par le client sans preuve qu'elle a été honorée en contrepartie ; un second chemin de paiement, explicitement documenté comme factice dans son propre code, crédite directement le portefeuille jusqu'à un plafond élevé par appel, sans aucune vérification de paiement ni grille de prix serveur ; l'état serveur qui conditionne l'attribution d'une récompense exclusive à stock limité peut être forgé entièrement côté client ; un chemin d'attribution de cette même récompense contourne à la fois le contrôle de stock et le contrôle anti-doublon, y compris pour des comptes n'ayant rien forgé ; deux routes de mise à jour d'un module publicitaire appliquent au modèle en base l'intégralité du corps de requête envoyé par le client sans restreindre les champs acceptés, ce qui permet d'écrire directement des champs financiers et d'état censés n'être modifiables que par des chemins contrôlés côté serveur ; une route créditrice d'un module de monétisation existe en parallèle d'un chemin protégé équivalent, sans reprendre aucune de ses protections — ni consommation de l'état qui fonde le montant, ni vérification que le bénéficiaire désigné par le client est bien la partie légitime — ce qui permet de rejouer indéfiniment le même crédit et de le rediriger vers un compte tiers ; une route de consommation d'objet d'inventaire accepte une quantité sans borner son signe, et la requête SQL sous-jacente ne fait pas la distinction entre consommer et ajouter — une valeur du mauvais signe multiplie un objet déjà possédé au lieu de le consommer ; un compteur qui alimente directement, y compris via le chemin de versement jusqu'ici tenu pour le plus sain de ce module, le calcul d'une récompense en monnaie réelle peut être incrémenté par le client sans aucune preuve qu'une activité correspondante a eu lieu ; une route ne demandant aucune authentification déclenche une opération bloquante qui gèle le serveur entier le temps de son exécution, sans qu'aucun compte ni jeton ne soit nécessaire pour la déclencher |
| **Moyenne** | **5** | Un mécanisme de confiance destiné au trafic applicatif légitime repose sur des informations entièrement fournies par le client, sans attache cryptographique — il conditionne l'exemption de plusieurs limites de débit, y compris sur l'opération créditrice ci-dessus ; un chemin d'échec d'upload laisse un fichier volumineux sur disque indéfiniment, sans purge ; une route d'écriture accepte sans aucune validation de type ni de borne une statistique financière d'affichage propre au compte appelant, qui alimente ensuite un tableau de bord agrégé consulté par ce même compte ; un module entier de routes de maintenance interne (rechargement de cache, retraitement en masse) n'exige qu'une authentification simple, sans contrôle de rôle ni limite de débit dédiée, et chacune déclenche des centaines à des milliers d'opérations séquentielles en base par appel ; une route d'invalidation de cache accessible à tout compte authentifié déclenche, sans vérifier aucun lien avec une action réelle de l'appelant, un balayage bloquant de l'ensemble d'un keyspace Redis partagé suivi d'une suppression en masse pour tous les utilisateurs |
| **Élevée** | **2** | Une route d'administration économique accepte un montant sans valider qu'il est bien numérique : une requête malformée (champ omis, faute de frappe, valeur non numérique) n'est pas rejetée, elle remet silencieusement à zéro le solde de la cible et déplace la totalité vers la trésorerie, sans message d'erreur ; un type de média uploadé n'est, contrairement aux autres types du même dépôt, ni filtré par son contenu réel ni retraité avant d'être publié tel quel sur une URL publique, avec une extension de fichier laissée au choix du client |

**À ce stade : 16 constats, dont 9 critiques et 2 élevés.** Le neuvième
constat critique se distingue de tous les autres : il ne demande aucun
compte, aucun jeton, aucune connaissance du système économique — seulement
l'URL de la route — pour un impact qui touche la disponibilité de la
plateforme entière plutôt qu'un seul compte ou un seul solde. Le sixième
constat critique est, avec le tout premier de cette section, celui dont
l'exploitation demande le moins d'étapes : un seul appel HTTP, répétable
sans délai, sans avoir besoin de forger quoi que ce soit au préalable — un
compte qui remplit légitimement la condition d'accès au module concerné
suffit. Le septième est plus restreint en portée (il faut déjà posséder
l'objet visé) mais tout aussi direct — un seul appel, un seul champ, un
seul mauvais signe. Les deux constats
moyens touchent le premier constat critique : le second lève la limite de
débit qui aurait pu, à défaut d'autre chose, borner son ampleur. Le
troisième constat critique aggrave le second : même si la forge de
progression était corrigée, le chemin d'attribution qu'il documente
resterait un moyen d'obtenir la même récompense en dépassant son plafond de
stock. Le cinquième constat critique est indépendant des quatre premiers —
module différent, mécanisme différent (assignation de masse plutôt
qu'absence de vérification de paiement).

## Constat critique — détail (décompte uniquement ici, méthode complète transmise au propriétaire)

Une route qui crédite un compte en monnaie de la plateforme le fait sur la
foi d'un identifiant d'offre et d'un identifiant de méthode de paiement
fournis par le client, sans qu'aucune vérification d'un paiement réellement
effectué n'intervienne à aucune étape de la chaîne d'appel — recherche menée
sur l'ensemble du dépôt et sur ses dépendances déclarées, sans résultat. Le
seul contrôle en amont est un moteur de score de risque comportemental, qui
n'atteste pas qu'un paiement a eu lieu.

## Constat critique (2/2) — détail (décompte uniquement ici)

Une route destinée à faire progresser un défi accepte directement, sans
recalcul côté serveur à partir d'une activité réelle, la valeur de
progression envoyée par le client. Cette valeur devient l'état qu'une autre
route consulte ensuite pour décider si le défi est complété, puis si sa
récompense peut être réclamée. Une troisième route s'appuie sur cet état
pour attribuer un objet exclusif à stock limité. Aucune des trois étapes ne
revérifie que la progression correspond à une activité réellement
accomplie : un compte peut se déclarer complet et réclamer sans jamais avoir
rempli aucune condition.

## Constat moyen — détail (décompte uniquement ici)

Le mécanisme qui distingue le trafic applicatif « de confiance » du reste
repose exclusivement sur des en-têtes de requête HTTP ordinaires, sans
signature ni attestation d'aucune sorte. Ce mécanisme conditionne
l'exemption de plusieurs limiteurs de débit du dépôt, y compris — c'est ce
qui en fait un constat à part entière plutôt qu'une note en marge du premier —
celui qui aurait pu limiter l'ampleur du constat critique ci-dessus.

## Constat moyen (2/2) — détail (décompte uniquement ici)

Une route d'upload traite le fichier reçu par un outil externe avant de le
ranger à son emplacement final. Quand cet outil échoue à interpréter le
contenu envoyé — ce qui inclut le cas simple d'un fichier qui n'est pas ce
qu'il prétend être — le chemin d'erreur emprunté ne supprime jamais le
fichier déjà écrit sur disque. Le fichier peut atteindre plusieurs centaines
de mégaoctets, et rien dans le dépôt ne le purge ensuite.

## Constat critique (5/5) — détail (décompte uniquement ici)

Deux routes de mise à jour d'un module publicitaire transmettent
l'intégralité du corps de requête reçu directement à la méthode de mise à
jour du modèle, sans liste blanche de champs modifiables. Le modèle
concerné porte, parmi ses colonnes, des champs financiers et un champ
d'état qui conditionnent normalement un flux de crédit/débit contrôlé côté
serveur. Ces deux routes contournent entièrement ce flux contrôlé.

## Constat moyen (3/3) — détail (décompte uniquement ici)

Une route d'écriture propre à un module de statistiques financières accepte
directement, sans aucun contrôle de type ni de plage, les valeurs envoyées
par le client pour les champs qui composent ensuite un montant affiché. Le
périmètre touché reste celui du compte appelant (pas d'IDOR constaté), et
aucun lien vers un versement réel n'a été trouvé dans le dépôt à ce stade —
d'où le classement en gravité moyenne plutôt que critique — mais rien
n'empêche aujourd'hui ce montant affiché d'être entièrement fictif.

## Constat critique (6/6) — détail (décompte uniquement ici)

Un module de monétisation expose deux chemins distincts vers la même
opération créditrice : l'un, automatisé, consomme l'état qui sert de base
au calcul du montant avant de rendre la main, empêchant tout rejeu ; l'autre,
une route HTTP directe, recalcule le même montant à partir du même état sans
jamais le consommer ni vérifier qu'il ne l'a pas déjà été. Le second chemin
accepte en outre l'identité du bénéficiaire depuis le corps de la requête,
sans la confronter à l'appelant ni à la partie que le montant calculé est
censé récompenser.

## Constat critique (7/7) — détail (décompte uniquement ici)

Une route qui consomme un exemplaire d'un objet d'inventaire accepte une
quantité fournie par le client sans vérifier son signe. La requête qui
applique cette quantité le fait par simple soustraction arithmétique dans
la même instruction SQL — une valeur négative devient donc une addition, et
la condition censée empêcher de descendre sous zéro ne protège pas contre
ce cas puisqu'elle compare dans le même sens que l'opération elle-même.

## Constat critique (8/8) — détail (décompte uniquement ici)

Une route incrémente un compteur de vues sur simple déclaration du client,
sans aucune preuve qu'une vue ait réellement eu lieu, sans limite de
déduplication par utilisateur. Ce même compteur alimente directement le
calcul du montant versé par le module de monétisation — y compris par son
chemin de versement automatisé, jusqu'ici le seul des deux chemins de ce
module tenu pour sain dans cette section. C'est un moyen indépendant
d'obtenir un versement réel à partir d'une activité entièrement fabriquée,
qui ne dépend d'aucune des failles déjà documentées du chemin direct de ce
même module.

## Constat critique (9/9) — détail (décompte uniquement ici)

Une route ne porte aucun middleware d'authentification, contrairement à une
route voisine du même fichier qui accomplit une tâche apparentée et qui,
elle, exige bien un compte administrateur — tout indique une omission
plutôt qu'un choix. Cette route déclenche une lecture disque bloquante
suivie d'un parsing binaire entièrement synchrone, sans découpage ni appel
asynchrone à aucune étape. Le modèle d'exécution du serveur ne permet
qu'un seul fil d'exécution principal : pendant toute la durée de cette
opération, aucune autre requête sur l'ensemble de la plateforme ne peut
être traitée. Aucun compte, aucun jeton, aucune connaissance préalable
n'est nécessaire pour la déclencher.

## Constat moyen (4/4) — détail (décompte uniquement ici)

Un module entier de routes destinées à la maintenance interne d'un moteur de
recommandation (rechargement de cache, retraitement en masse de contenu)
n'exige qu'une authentification simple, sans aucun contrôle de rôle. Deux de
ces routes déclenchent chacune, en une seule requête HTTP, plusieurs
centaines à plus d'un millier d'opérations séquentielles en base de données.
Aucune limite de débit dédiée ne couvre ce module — seul le quota global
s'applique, lui-même contournable par le mécanisme déjà documenté dans le
constat moyen ci-dessus. N'importe quel compte enregistré peut donc
déclencher, en boucle, une charge de base de données disproportionnée par
rapport à un seul appel HTTP.

## Constat moyen (5/5) — détail (décompte uniquement ici)

Une route destinée à signaler qu'un compte vient de publier un contenu
n'établit aucun lien vérifié entre l'appelant et ce contenu, et déclenche
en retour une opération d'invalidation sur un magasin de cache partagé
portant sur l'ensemble des utilisateurs de la plateforme, via une commande
connue pour son coût proportionnel à la taille totale du magasin plutôt
qu'à ce qui doit réellement être invalidé. Aucun contrôle de débit dédié ne
couvre cette route.

## Vérifié et trouvé sain (S3, à ce stade)

- **SQL par concaténation / nom de colonne piloté par l'utilisateur :**
  balayage large mené sur les tris et filtres paramétrables trouvés dans
  `src/routes/`. Partout où un tri est proposé au client, le nom de colonne
  réellement utilisé dans la requête est choisi côté serveur par une
  correspondance fixe (ternaire ou table de correspondance), jamais construit
  à partir de la valeur envoyée par le client. Un cas plus complexe, à
  l'intérieur d'un outil interne piloté par un modèle de langage, envoyait
  une direction de tri non filtrée dans du SQL brut — mais elle est
  contrainte par un schéma de validation strict imposé avant l'exécution de
  l'outil, qui bloque toute valeur hors de `asc`/`desc`. Aucun cas exploitable
  trouvé à ce stade.
- **Upload d'image (avatar, bannière, image de tweet) :** le type déclaré par
  le client n'est qu'un premier filtre, mais le fichier est ensuite
  systématiquement retraité par une bibliothèque de manipulation d'image qui
  échoue sur tout contenu qui n'est pas réellement une image, avant d'écrire
  un fichier de sortie entièrement reconstruit sous un nom choisi par le
  serveur. C'est une validation de fait du contenu réel, et une protection
  efficace contre un contenu actif déguisé en image.
- **Réutilisation d'une autorisation anti-fraude pour une opération
  différente :** l'empreinte qui lie chaque autorisation à l'opération
  autorisée inclut le type d'opération, le montant, la devise et les
  parties concernées, pas seulement l'utilisateur — une autorisation
  obtenue pour une opération ne peut donc pas être consommée pour une
  opération différente, même par le même utilisateur. Vérifié à la fois
  côté génération de l'empreinte et côté consommation (comparaison stricte
  avant de marquer l'autorisation utilisée).
- **Mot de passe oublié — abus par répétition :** chaque nouvelle demande
  écrase la précédente en base avant toute vérification, donc aucune
  accumulation de jetons valides n'est possible ; de plus, l'envoi de
  l'e-mail contenant le lien n'est à ce stade pas implémenté (fonctionnalité
  incomplète, déjà documentée en B2), ce qui borne encore l'impact d'un
  éventuel abus de débit sur cette route précise.
- **Rejeu d'une opération créditrice sur échange/virement internes :**
  aucune clé d'idempotence n'existe sur ces deux routes, donc une requête
  network-retry pourrait exécuter l'opération deux fois — mais dans les deux
  cas l'opération déplace des fonds qui appartiennent déjà à l'appelant
  (échange entre ses propres portefeuilles, ou virement d'un solde
  qu'il doit posséder), sans mécanisme permettant d'en tirer un gain net ;
  ce n'est pas un vecteur d'enrichissement, seulement un désagrément
  fonctionnel potentiel pour l'utilisateur qui réessaierait après un
  timeout.

## Suite

Le détail complet — chemins exacts, méthode, correctif — est transmis au
propriétaire hors dépôt. La poursuite de la section (validation des routes
d'écriture restantes, limitation de débit sur authentification, rejeu
d'opération créditrice sur les autres routes économiques) est décrite dans
`AUDIT-PROGRESS.md`.
