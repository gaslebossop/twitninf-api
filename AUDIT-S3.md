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
| **Critique** | **1** | Une opération créditrice peut être déclenchée par le client sans preuve qu'elle a été honorée en contrepartie |
| **Moyenne** | **2** | Un mécanisme de confiance destiné au trafic applicatif légitime repose sur des informations entièrement fournies par le client, sans attache cryptographique — il conditionne l'exemption de plusieurs limites de débit, y compris sur l'opération créditrice ci-dessus ; un chemin d'échec d'upload laisse un fichier volumineux sur disque indéfiniment, sans purge |

**À ce stade : 3 constats, dont 1 critique.** Les deux premiers se combinent :
le second lève la limite de débit qui aurait pu, à défaut d'autre chose,
borner l'ampleur du premier.

## Constat critique — détail (décompte uniquement ici, méthode complète transmise au propriétaire)

Une route qui crédite un compte en monnaie de la plateforme le fait sur la
foi d'un identifiant d'offre et d'un identifiant de méthode de paiement
fournis par le client, sans qu'aucune vérification d'un paiement réellement
effectué n'intervienne à aucune étape de la chaîne d'appel — recherche menée
sur l'ensemble du dépôt et sur ses dépendances déclarées, sans résultat. Le
seul contrôle en amont est un moteur de score de risque comportemental, qui
n'atteste pas qu'un paiement a eu lieu.

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

## Suite

Le détail complet — chemins exacts, méthode, correctif — est transmis au
propriétaire hors dépôt. La poursuite de la section (validation des routes
d'écriture restantes, limitation de débit sur authentification, rejeu
d'opération créditrice sur les autres routes économiques) est décrite dans
`AUDIT-PROGRESS.md`.
