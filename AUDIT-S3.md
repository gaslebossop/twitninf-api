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
| **Moyenne** | **1** | Un mécanisme de confiance destiné au trafic applicatif légitime repose sur des informations entièrement fournies par le client, sans attache cryptographique — il conditionne l'exemption de plusieurs limites de débit, y compris sur l'opération créditrice ci-dessus |

**À ce stade : 2 constats, dont 1 critique.** Les deux se combinent : le
second lève la limite de débit qui aurait pu, à défaut d'autre chose, borner
l'ampleur du premier.

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

## Suite

Le détail complet — chemins exacts, méthode, correctif — est transmis au
propriétaire hors dépôt. La poursuite de la section (SQL par concaténation,
validation des routes d'écriture, upload, limitation de débit sur
authentification) est décrite dans `AUDIT-PROGRESS.md`.
