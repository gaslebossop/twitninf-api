# B1 — Verrous et concurrence

> Section 5 de l'audit `twitninf-api`. Priorité **ROBUSTESSE**.
>
> On cherche ici : transactions longues, verrous tenus autour d'un appel réseau,
> ordre de verrouillage incohérent entre deux chemins, `FOR UPDATE` trop large.
>
> Précédent connu sur ce dépôt : *un verrou trop fort sur la table des
> utilisateurs, autour d'un appel au grand livre, figeait la requête.* Les cas
> de même forme sont cherchés en priorité.
>
> Chaque constat est vérifié dans le code avant d'être écrit. Quand une
> incertitude subsiste, elle est dite explicitement. Les constats sont classés
> par gravité décroissante.

---

## B1-01 — `EconomyMetrics.refresh()` : trois défauts de concurrence dans une seule fonction, appelée par **toute** l'économie

**Où :** `src/economy/metrics.js:100-175`, appelée depuis **20 endroits**, dont
`newEconomyService.js:140`, `:225`, `:269`, `:296-297`, `:317`, `:406`,
`casinoService.js:242`, `contestService.js:405`, `:424`,
`economyAdminController.js:87`, `:292`, `:352`, `:421` — **avec la transaction
en cours** à chaque fois.

Autrement dit : chaque minage, chaque transfert, chaque achat, chaque partie de
casino, chaque distribution de concours passe par cette fonction, à l'intérieur
de sa transaction.

### a) Elle prend un verrou de ligne sur la monnaie — point de sérialisation global

Ligne 156 :

```js
await currency.update(
  { circulatingSupply, currentPrice, volume24h, marketCap, economicTrend,
    priceChange24h, priceHistory: filteredHistory },
  { transaction: dbTransaction }
);
```

Un `UPDATE` prend un verrou exclusif sur la ligne, **tenu jusqu'au `COMMIT`**.
Comme il n'existe qu'une seule ligne par monnaie, et que toutes les opérations
économiques portent sur la même monnaie principale, **toutes les transactions
économiques de la plateforme se sérialisent sur cette unique ligne**.

Le débit maximal de l'économie entière devient donc : `1 / durée de la
transaction`. Ce n'est pas un problème de verrou *incorrect* — la mise à jour
est légitime — mais de **granularité** : on a transformé un compteur en
sémaphore global.

### b) Elle agrège toute la table des portefeuilles, sous ce verrou

Ligne 106, via `sumBalances` (`:65-71`) :

```js
const total = await UserWallet.sum('balance', { where: { currencyId }, transaction: dbTransaction });
```

C'est un `SUM` sur l'intégralité de `user_wallets` pour cette monnaie —
c'est-à-dire un portefeuille par utilisateur. À 500 000 utilisateurs, c'est un
parcours de 500 000 lignes, **exécuté à l'intérieur de la transaction**, donc
pendant que le verrou du point (a) est tenu.

La durée du verrou global n'est donc pas « le temps d'écrire un compteur » :
c'est le temps d'agréger toute la table des soldes. Et cette durée croît avec le
nombre d'utilisateurs. C'est la forme exacte du précédent connu — un verrou
large tenu autour d'un travail long — simplement déplacée de la table des
utilisateurs vers celle des portefeuilles.

### c) `purchaseVolume24h` s'exécute **hors** de la transaction — risque d'interblocage sur le pool

Ligne 108 :

```js
const { volumeEur, volumeTwc, count } = await this.purchaseVolume24h(currencyId);
```

et sa définition (`:81-95`) :

```js
static async purchaseVolume24h(currencyId) {     // ← ne reçoit AUCUNE transaction
  const rows = await Transaction.findAll({ where: { … } });   // ← ni n'en passe une
}
```

Les deux autres aides (`sumBalances`, `getTreasuryBalance`) acceptent et
propagent `dbTransaction`. Celle-ci, non. Elle emprunte donc **une seconde
connexion** au pool, pendant que la transaction appelante en détient déjà une —
et détient ses verrous.

C'est un interblocage classique et particulièrement désagréable, parce qu'il
n'apparaît **que sous charge** :

1. Le pool a N connexions ; N transactions économiques démarrent et les prennent
   toutes.
2. Chacune atteint la ligne 108 et demande une connexion supplémentaire.
3. Il n'en reste aucune. Chaque transaction attend une connexion qui ne sera
   libérée que lorsqu'une transaction se terminera — ce qu'aucune ne peut faire.
4. Tout se débloque uniquement à l'expiration du délai d'acquisition du pool,
   et l'économie entière remonte alors en erreur d'un coup.

À faible charge, cela ne se produit jamais. C'est pourquoi ce défaut survit aux
tests et n'apparaît qu'en production, au pire moment.

**Aggravation :** cette lecture hors transaction rend aussi le calcul
**incohérent** — le volume sur 24 h est lu dans un état de la base différent de
celui des soldes, dans la même « photo » censée être atomique.

### Correctif

Les trois défauts se corrigent séparément, par ordre d'urgence :

1. **Propager la transaction à `purchaseVolume24h`** — deux lignes, et
   l'interblocage de pool disparaît :

   ```js
   static async purchaseVolume24h(currencyId, dbTransaction = null) {
     const rows = await Transaction.findAll({ where: { … }, transaction: dbTransaction });
   ```
   et, à l'appel : `await this.purchaseVolume24h(currencyId, dbTransaction)`.

   *C'est le geste à faire en premier.* Il aligne cette aide sur les deux
   autres du même fichier, et corrige au passage l'incohérence de lecture.

2. **Sortir l'agrégat du chemin transactionnel.** `circulatingSupply` n'a pas
   besoin d'être exact à la microseconde : c'est une donnée d'affichage. Deux
   options, au choix :
   - maintenir le total **par incréments** (`circulatingSupply = circulatingSupply
     + :delta`) plutôt que par recalcul — l'`UPDATE` devient instantané et le
     `SUM` disparaît ;
   - ou déplacer le recalcul complet dans une tâche périodique hors transaction,
     et ne mettre à jour, dans la transaction, que ce qui doit l'être.

   La première option est la meilleure : elle supprime le `SUM` **et** rend le
   verrou du point (a) court.

3. **Cesser d'appeler `refresh()` depuis chaque transaction.** Le prix et les
   métriques n'ont pas à être recalculés à chaque partie de casino. Un appel
   périodique (toutes les N secondes) ou déclenché après `COMMIT` suffit —
   `newEconomyService.js:422`, `:475` et `economicVariationsService.js:11`
   l'appellent d'ailleurs **déjà sans transaction**, ce qui montre que l'appel
   transactionnel n'est pas une nécessité de conception.

### Ce qui est déjà bien fait dans le voisinage

`submitMiningProof` (`newEconomyService.js:371-415`) prend son `FOR UPDATE` sur
la **ligne du round** — l'objet réellement disputé — et **pas** sur la ligne de
l'utilisateur. Le `findByPk(userId, …)` de la ligne 401 est délibérément **sans
`lock`**. C'est exactement la bonne granularité, et c'est manifestement la leçon
tirée du précédent connu. Le problème ne vient pas de ce code-là, mais de
`refresh()` appelé juste après (ligne 406).

**Gravité :** le point (c) est le plus grave — c'est un blocage total de
l'économie sous charge, invisible en test. Le point (b) est un plafond de débit
qui se resserre à mesure que la plateforme grandit.

---

## B1-02 — Le service anti-fraude écrit **hors** de la transaction de l'appelant, avec un pool de 10 connexions et un délai d'acquisition de 60 s

**Où :** `src/services/transactionAuthorizationService.js` — `_claimAuthorization`
(`:318-406`) exécute quatre requêtes (`INSERT` `:320`, `SELECT` `:347`,
`UPDATE` `:396`) **sans jamais passer de `transaction`**, et
`_recordReplayMismatch` (`:409`) ouvre carrément **sa propre transaction
indépendante** (`sequelize.transaction(async (dbTransaction) => …)`).

Ces fonctions sont appelées par `authorize()`, elle-même appelée depuis
`src/economy/ledger.js:155`, `:228`, `:395`, `:687`, et depuis
`src/economy/multiCurrencyPayment.js:294` — c'est-à-dire depuis le grand livre,
au cœur de chaque opération d'argent.

**Le paramétrage qui rend cela dangereux** (`src/config/config.js:51-56`) :

```js
pool: {
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,     // ← 10 connexions
  min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
  acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 60000,   // ← 60 secondes
  idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000
},
```

et `dialectOptions.idle_in_transaction_session_timeout: 60000` (`:67`).

**Le mécanisme.** Une transaction Sequelize détient une connexion du début à la
fin. Si, à l'intérieur, on exécute une requête **sans** passer cette
transaction, Sequelize en emprunte une **deuxième** au même pool. Tant que le
pool a du mou, personne ne voit rien. Quand il n'en a plus :

1. 10 opérations économiques démarrent et prennent les 10 connexions.
2. Chacune appelle `authorize()`, qui demande une 11ᵉ connexion.
3. Il n'y en a plus. Chaque transaction attend une connexion qui ne se libérera
   qu'à la fin d'une transaction — or aucune ne peut finir.
4. Rien ne se débloque avant **60 secondes** (`acquire`), puis toutes échouent
   en même temps.

Un interblocage qui met une minute à se déclarer et qui frappe **toute
l'économie d'un coup**. Il n'apparaît jamais en test, parce qu'il exige
exactement 10 opérations simultanées.

**Ce n'est pas une hypothèse : l'incident a déjà eu lieu.** Le commentaire de
`src/services/usernameMarketService.js:358-372` le décrit précisément :

> « le grand livre demande une autorisation anti-fraude qui insère une ligne
> référençant ces mêmes comptes — **sur une AUTRE connexion, hors de cette
> transaction**. Cette insertion prend un verrou `FOR KEY SHARE` sur `users`,
> incompatible avec `FOR UPDATE` : elle attendait la fin d'une transaction qui,
> elle, attendait l'insertion. La requête mourait sur le délai de 3 s de
> Sequelize, et l'app voyait "Achat impossible". »

Le correctif appliqué à l'époque — passer de `FOR UPDATE` à
`NO KEY UPDATE` — est **juste, et il faut le garder** : il règle bien le
conflit de verrous de clé. Mais il traite le symptôme. La cause, « l'écriture
part sur une autre connexion pendant que la transaction est ouverte », est
toujours là, et elle a deux autres conséquences que `NO KEY UPDATE` ne couvre
pas :

- **l'épuisement du pool** décrit ci-dessus, qui ne dépend d'aucun verrou de
  ligne et que rien n'empêche aujourd'hui ;
- **une atomicité rompue** : si la transaction de l'appelant est annulée, la
  ligne d'autorisation, elle, a déjà été validée. Elle expire au bout de 15
  secondes (`expires_at = NOW() + INTERVAL '15 seconds'`, `:331`), ce qui limite
  la casse — mais pendant ces 15 secondes une autorisation existe pour une
  opération qui n'a jamais eu lieu. À recouper avec S3 (rejeu d'opération
  créditrice), où cette fenêtre mérite un examen dédié.

Le même schéma existe une deuxième fois, indépendamment : `EconomyMetrics.
purchaseVolume24h` (B1-01, point c). Deux chemins distincts vers le même
interblocage.

**Correctif.**

1. **Faire circuler la transaction.** `authorize()` et ses aides doivent accepter
   un paramètre `dbTransaction` optionnel et le passer à chaque
   `sequelize.query`, exactement comme `consume()` le fait déjà
   (`ledger.js:146` : `consume(authorization, tx.id, dbTransaction)`). Le motif
   correct est donc **déjà présent dans ce fichier** — il n'est simplement pas
   appliqué à `authorize`.

   *Attention :* rendre l'écriture transactionnelle change son moment de
   validation. Il faut vérifier que le mécanisme d'idempotence
   (`ON CONFLICT (idempotency_key) DO NOTHING`) reste efficace : deux requêtes
   concurrentes dans deux transactions non validées ne se voient pas encore. Si
   l'anti-rejeu doit rester visible immédiatement, la bonne réponse n'est pas
   « hors transaction » mais une transaction courte **avant** l'ouverture de
   celle de l'appelant — ce que fait déjà le grand livre en appelant `authorize`
   **avant** `lockWallet` (`ledger.js:155` puis `:168`).

2. **Relever le plafond du pool.** `DB_POOL_MAX=10` est bas pour une API qui sert
   des milliers d'utilisateurs. Le porter à 25-30 ne corrige pas le défaut, mais
   il éloigne beaucoup le seuil pendant qu'on applique le point 1. Une variable
   d'environnement, effet immédiat.

3. **Baisser le délai d'acquisition.** 60 secondes, c'est une minute pendant
   laquelle une requête bloquée occupe un contexte et fait attendre un
   utilisateur avant d'échouer. 5 à 10 secondes suffisent : on échoue vite, on
   le voit dans les journaux, et on ne transforme pas une saturation
   momentanée en indisponibilité longue.

4. **Poser une règle et la faire respecter.** « Toute fonction susceptible d'être
   appelée depuis une transaction accepte et propage `dbTransaction` ». Une
   revue ciblée sur `sequelize.query(` et `Model.findAll(` sans `transaction:`
   dans `src/economy/` et `src/services/transactionAuthorizationService.js`
   suffirait à trouver les autres cas.

**Gravité :** la plus élevée de cette section. C'est un blocage total de
l'économie, déclenché par la charge et non par une donnée particulière,
invisible en test, avec un incident déjà survenu sur la même cause.

---

## B1-03 — `POST /api/messages/direct/:userId` : jusqu'à **3 connexions supplémentaires** empruntées pendant que la transaction est ouverte

**Où :** `src/routes/messageRoutes.js:597` (ouverture de `tx`), puis `:624`,
`:655` et `:658`.

```js
const tx = await sequelize.transaction();                                    // :597
…
const otherUser  = await User.findByPk(otherUserId, { transaction: tx });     // :620  ✅ dans tx
const privateGate = await canContactPrivateRecipient(currentUserId, otherUserId);   // :624  ❌ hors tx
…
const existing = await findExactDirectConversation(currentUserId, otherUserId, tx); // :655 ✅ dans tx (mais cf. R3-02)
const allowedWithoutInvitation = await canOpenDirectWithoutInvitation(currentUserId, otherUserId); // :658 ❌ hors tx
```

**Ce qui ne va pas.** Les deux fonctions de contrôle d'accès ne reçoivent pas
`tx` et n'en propagent aucune. Toutes leurs requêtes empruntent donc des
connexions **supplémentaires** au même pool, pendant que la transaction en
détient déjà une.

Le compte exact, en suivant le code :

- `canContactPrivateRecipient` (`:173-192`) : `User.findByPk` (`:178`) puis
  `UserFollow.isFollowing` (`:185`, qui fait un `findOne`,
  `src/models/UserFollow.js`) → **2 requêtes séquentielles**, hors transaction.
- `canOpenDirectWithoutInvitation` (`:194-215`) : `User.findByPk` (`:201`),
  éventuellement `isFollowing` (`:205`), sinon `User.findByPk` (`:208`) puis un
  **`Promise.all` de deux `isFollowing`** (`:211-214`) → jusqu'à **4 requêtes,
  dont 2 réellement simultanées**, hors transaction.

Le pic d'occupation est donc de **3 connexions par requête en vol** : celle de
la transaction, plus les deux du `Promise.all`.

**Effet concret.** Avec `DB_POOL_MAX = 10` (`src/config/config.js:52`),
**quatre premiers messages simultanés suffisent à vider le pool**. À partir de
là, chaque transaction attend une connexion que seule la fin d'une autre
transaction libérerait — l'interblocage de B1-02, atteint par un autre chemin,
et sur une route bien plus banale qu'un paiement : « envoyer un premier message
à quelqu'un ». Le déblocage n'intervient qu'au bout de `acquire = 60000` ms.

**Et cette transaction est longue.** `findExactDirectConversation` (`:655`),
appelée à l'intérieur, charge **toute la table `conversations`** avec ses
participants — c'est le constat R3-02. La fenêtre pendant laquelle les
connexions supplémentaires sont demandées n'est donc pas de quelques
millisecondes : elle dure le temps d'un parcours complet de table, et s'allonge
avec la plateforme. Les deux constats se renforcent exactement.

**Aggravation mineure mais réelle :** ces contrôles d'accès lisent hors de la
transaction, donc dans un instantané différent de celui où la conversation est
créée. La fenêtre est courte et l'enjeu faible ici, mais c'est le principe qui
compte : une décision d'autorisation prise sur un état, appliquée sur un autre.

**Ce qui est bien fait, et qu'il faut garder.** Les émissions Socket.io
(`:770-790` environ) sont toutes **après** `tx.commit()`. C'est la bonne
discipline : aucun effet de bord externe n'est déclenché avant que la
transaction ne soit validée. Cette règle est respectée partout où je l'ai
vérifiée dans ce fichier.

**Correctif.**

1. **Sortir les contrôles d'accès de la transaction.** Ils ne modifient rien et
   n'ont pas besoin d'être atomiques avec la création : les appeler **avant**
   `sequelize.transaction()` supprime le problème sans rien changer d'autre.
   C'est le correctif le plus simple et le plus sûr, et c'est exactement la
   discipline que suit déjà `src/economy/ledger.js:155` (autorisation **avant**
   verrou).
2. **À défaut, propager `tx`** — ajouter un paramètre `transaction` aux deux
   fonctions et le passer aux quatre appels de modèle. Corrige aussi
   l'incohérence d'instantané.
3. **Fusionner les requêtes.** `canContactPrivateRecipient` et
   `canOpenDirectWithoutInvitation` relisent le même destinataire et refont les
   mêmes `isFollowing`. Une seule requête jointe rendrait la décision en un
   aller-retour au lieu de six.

**Vérification à étendre.** Les mêmes symptômes sont à chercher dans les 9
autres transactions manuelles de ce fichier (`:821`, `:948`, `:1046`, `:1098`,
`:1209`, `:1303`…), que je n'ai **pas** examinées une à une. Le motif à repérer
est simple : à l'intérieur d'un bloc `tx`, tout appel de fonction qui touche la
base sans recevoir `tx`.

**Gravité :** élevée. Même famille que B1-02, mais atteinte par une route
ordinaire et sans lien avec l'économie — donc bien plus fréquemment sollicitée.

---

## B1-04 — Les gardes d'autorisation de groupe : même défaut, quatre fois de plus — et un **contrôle d'accès qui lit à côté de la transaction**

**Où :** `src/routes/messageRoutes.js:958` (`requireMembership`), `:1219`,
`:1353`, `:1388` (`requireGroupManagementRights`) — appelés à l'intérieur des
transactions ouvertes respectivement en `:948`, `:1209`, `:1303` et `:1378`
environ.

Les deux gardes :

```js
async function requireMembership(conversationId, userId) {          // :53
  return ConversationParticipant.findOne({
    where: { conversation_id: conversationId, user_id: userId }     // ← aucune transaction
  });
}

async function requireGroupManagementRights(conversationId, userId) { // :59
  const membership = await ConversationParticipant.findOne({
    where: { conversation_id: conversationId, user_id: userId }     // ← aucune transaction
  });
  if (!membership) return { ok: false, reason: 'not_member' };
  if (!['owner', 'admin'].includes(membership.role)) return { ok: false, reason: 'forbidden' };
  return { ok: true, membership };
}
```

Ni l'une ni l'autre n'accepte de paramètre `transaction`. Chacun de ces quatre
appels emprunte donc **une connexion de plus** pendant que la transaction
appelante en détient déjà une : c'est le mécanisme de B1-02 et B1-03, sur quatre
sites supplémentaires.

**Un second problème, propre à celui-ci : c'est un contrôle d'accès.**

`requireGroupManagementRights` décide si l'appelant a le droit d'administrer un
groupe — expulser un membre, changer les rôles, modifier le groupe. Il lit
`conversation_participants` **en dehors** de la transaction qui exécute
l'action. Les deux lectures voient donc deux instantanés différents de la base.

La fenêtre est étroite, mais elle existe : entre la vérification du rôle et
l'écriture, une transaction concurrente peut retirer ce rôle. Le contrôle a dit
« oui » sur un état qui n'est plus celui dans lequel l'action s'applique.
Passer `transaction` ferait lire les deux dans le même instantané — et, avec un
`lock` sur la ligne de participation, rendrait la décision réellement stable
jusqu'au `COMMIT`.

Je le signale comme un **problème de concurrence**, sa forme ici. Sa portée en
tant que faille d'autorisation sera examinée en section S2, où ce chemin est
noté pour être repris.

### Inventaire complet de ce défaut

J'ai balayé **tout** `src/` pour les deux formes de transaction, en cherchant
(1) les appels de modèle sans `transaction:` à l'intérieur d'un bloc
transactionnel, et (2) les appels de fonctions qui touchent la base sans
recevoir la transaction. Résultats :

| Recherche | Résultat |
|---|---|
| Appels de modèle sans `transaction:` dans un bloc `tx` (forme manuelle) | **0** |
| Idem, forme `sequelize.transaction(async (t) => …)` | **0** |
| Fonctions touchant la base appelées sans la transaction, forme callback | **0** |
| Fonctions touchant la base appelées sans la transaction, forme manuelle | **6** — *tous dans `messageRoutes.js`* |

Les six sites sont : `:624`, `:658` (constat B1-03), `:958`, `:1219`, `:1353`,
`:1388` (ce constat). **Le défaut est donc entièrement circonscrit à un seul
fichier**, ce qui rend la correction facile à cadrer et à vérifier.

Deux réserves sur ce balayage, pour ne pas le donner comme une preuve absolue :
il ne suit pas les appels **indirects** (une fonction qui reçoit `tx` mais
appelle une aide qui ne le propage pas), et il ne voit pas les appels traversant
un module (`someService.doThing(...)`). B1-01 et B1-02, trouvés à la lecture,
sont précisément de cette seconde forme — la discipline est donc bonne dans les
routes, et moins bonne dans les services d'économie.

**Correctif.** Le même pour les six sites, et il est mécanique :

```js
async function requireMembership(conversationId, userId, transaction = null) {
  return ConversationParticipant.findOne({
    where: { conversation_id: conversationId, user_id: userId },
    transaction,
  });
}
```

puis, aux quatre appels : `await requireMembership(conversationId, userId, tx)`.
Pour `requireGroupManagementRights`, ajouter en plus `lock: transaction?.LOCK.SHARE`
quand une transaction est fournie, afin que le rôle vérifié ne puisse pas
changer avant le `COMMIT`.

Les deux fonctions sont aussi appelées **hors** transaction ailleurs dans le
fichier : le paramètre optionnel avec `null` par défaut préserve ces appels sans
les modifier.

**Gravité :** moyenne pour la concurrence (quatre connexions de plus, sur des
routes d'administration de groupe, moins chaudes que l'envoi de message),
mais le point « contrôle d'accès lu hors transaction » mérite d'être corrigé
pour lui-même.

---

## B1-05 — Tirage d'un concours : le portefeuille de la trésorerie verrouillé pendant toute la durée d'une transaction **non bornée**

**Où :** `src/services/contestService.js:274` (`drawContest`), transaction
ouverte `:318`, boucle `:319`, versement `:326` (`settleEscrow`, boucle
interne `:372`).

```js
const entries = await ContestEntry.findAll({
  where: { contest_id: contestId },
  order: [['entered_at', 'ASC']],
});                                    // ← aucun `limit` : toutes les participations
…
await sequelize.transaction(async (transaction) => {
  for (const entry of entries) {
    await entry.save({ transaction });          // ← 1 UPDATE par participation, en série
  }
  await settleEscrow(contest, winners.map(w => w.entry), transaction);
  await contest.update({ status: 'closed', drawn_at: new Date() }, { transaction });
});
```

et, dans `settleEscrow` (`:372-373`) :

```js
for (const winner of winners) {
  await EconomyLedger.rewardFromTreasury(…, transaction);
}
```

**Ce qui ne va pas — trois couches.**

### a) La durée de la transaction est fixée par le nombre de participants

`entries` n'est pas borné. Chaque participation donne un `UPDATE` séquentiel
**à l'intérieur** de la transaction. Pour un concours à 50 000 participations et
2 ms d'aller-retour, cela fait ~100 secondes de transaction ouverte, pendant
lesquelles tous ses verrous sont tenus et une connexion du pool de 10 est
immobilisée.

### b) Elle verrouille le portefeuille de la **trésorerie** — une ligne unique, partagée par toute l'économie

`rewardFromTreasury` (`src/economy/ledger.js:304`) fait :

```js
const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);
```

et `lockWallet` (`:105-117`) pose un `FOR UPDATE` sur la ligne. Ce verrou est
tenu **jusqu'au `COMMIT`**, donc jusqu'à la fin du tirage entier.

Or la trésorerie est la contrepartie de presque toutes les opérations
économiques : `spendToTreasury` (achat de pseudo, contenus payants…),
`rewardFromTreasury` (récompenses, minage, casino). **Pendant un tirage de
concours, toute l'économie de la plateforme attend sur cette ligne.** Les autres
requêtes ne sont pas ralenties : elles sont bloquées, jusqu'à ce que le tirage
finisse ou que `statement_timeout` (60 s, `src/config/config.js:66`) les tue.

C'est, à la lettre, la forme du précédent connu — un verrou trop large tenu
autour d'un travail long — cette fois sur le portefeuille de la trésorerie
plutôt que sur la table des utilisateurs.

### c) Chaque versement emprunte encore une connexion hors transaction

`rewardFromTreasury` appelle `transactionAuthorizationService.authorize()`, dont
les écritures se font hors transaction (B1-02). Le tirage exécute donc, en plus,
une demande de connexion supplémentaire **par gagnant**, alors que le pool est
déjà réduit et que la transaction dure.

**Ce qui est bien fait, et qu'il faut garder.**

- Le verrouillage du concours par `UPDATE … WHERE status = 'open'` puis test de
  `claimed === 0` (`:278-282`) est un excellent verrou optimiste : deux
  exécutions simultanées du cron ne peuvent pas tirer deux fois le même
  concours. Le commentaire l'explicite.
- Le recontrôle d'éligibilité (`checkConditions`, boucle `:295`) est fait
  **avant** d'ouvrir la transaction. C'est exactement la bonne décision, et
  c'est ce qui évite que la partie la plus coûteuse (une requête par
  participant) ne soit dans la transaction.
- L'atomicité voulue est légitime et le commentaire la justifie bien : « soit
  les gagnants sont payés ET le concours est clos, soit rien n'a bougé ». Le
  problème n'est pas de vouloir l'atomicité, c'est ce qu'on a mis dedans.

**Correctif.**

1. **Sortir de la transaction ce qui n'a pas besoin d'y être.** Le passage des
   participations en `eligible`/`rejected` est un enregistrement de résultat, pas
   une opération d'argent : il peut être écrit avant, hors transaction. Seuls le
   versement aux gagnants et la clôture du concours ont besoin d'être atomiques
   — et le nombre de gagnants, lui, est borné (`contest.winners_count`).
2. **Remplacer la boucle de `save()` par une écriture en lot.** Deux `UPDATE …
   WHERE id = ANY(:ids)` (un pour les éligibles, un pour les rejetés) remplacent
   les N allers-retours par deux. Même si l'on tient à les garder dans la
   transaction, sa durée cesse alors de dépendre du nombre de participants.
3. **Verrouiller la trésorerie le plus tard et le moins longtemps possible.**
   Idéalement, un seul débit agrégé de la trésorerie (`- Σ récompenses`) suivi
   des crédits individuels, plutôt qu'un `FOR UPDATE` repris pour chaque
   gagnant. La ligne de trésorerie est de toute façon un point chaud : elle
   mériterait, à terme, d'être remplacée par un compteur incrémental plutôt que
   par une ligne verrouillée (même remarque qu'en B1-01, point b).
4. **Borner `entries`.** Même après les points 1 et 2, charger toutes les
   participations en mémoire reste un risque de saturation ; un traitement par
   tranches est préférable.

**Gravité :** élevée. Contrairement à B1-02 et B1-03, ce blocage ne demande
aucune concurrence particulière pour se produire — **un seul tirage de concours
suffit**, et il est déclenché par un cron, donc à une heure fixe, sur toutes les
instances à la fois.

---

## B1-06 — Deux boucles non bornées dans une transaction, dont une qui interroge la base **à côté** d'elle

### a) `POST /api/messages/groups` — une requête hors transaction par participant, sans plafond

**Où :** `src/routes/messageRoutes.js:821` (ouverture de `tx`), `:845-855`.

```js
const participantIds = Array.isArray(req.body?.participantIds) ? req.body.participantIds : [];   // :825
const uniqueParticipants = Array.from(new Set([userId, ...participantIds.filter(Boolean)]));     // :828
…
for (const pid of uniqueParticipants) {
  if (sameId(pid, userId)) continue;
  const followsCreator = await UserFollow.isFollowing(pid, userId);   // :847 — AUCUNE transaction
  …
}
```

Deux problèmes qui se multiplient :

1. **`participantIds` n'est borné par rien.** La route ne déclare aucune
   validation `express-validator`, et le seul contrôle est `length < 2` (`:829`)
   — un minimum, pas un maximum. Le client fixe donc le nombre d'itérations.
2. **`UserFollow.isFollowing` (`src/models/UserFollow.js`) ne reçoit pas `tx`.**
   Chaque itération emprunte donc une connexion au pool, séquentiellement,
   pendant que la transaction est ouverte.

**Effet concret.** Une création de groupe avec 2 000 identifiants ouvre une
transaction, puis exécute 2 000 requêtes en série sur des connexions
empruntées — plusieurs secondes de transaction ouverte, sur un pool de 10
(`src/config/config.js:52`). Quelques appels simultanés suffisent à reproduire
l'interblocage de B1-02, à partir d'une route de messagerie ordinaire.

**Correctif.**
- Plafonner : `body('participantIds').isArray({ min: 1, max: 50 })`, comme le
  fait déjà `userRoutes.js:386` (`isArray({ min: …, max: 30 })`) et
  `tweetRoutes.js:3291` (`max: 50`). Le dépôt connaît la pratique.
- Remplacer la boucle par **une seule requête** : `UserFollow.findAll({ where:
  { follower_id: { [Op.in]: uniqueParticipants }, following_id: userId,
  status: 'active' }, attributes: ['follower_id'], transaction: tx })`, puis un
  `Set` en mémoire. N allers-retours deviennent un, et il est dans la
  transaction.

### b) `POST` retrait anti-fraude — `Promise.all` de `refresh()` **sur la même transaction**

**Où :** `src/controllers/economyAdminController.js:66-88`.

```js
const { items, reason } = req.body;                       // :66 — aucun plafond
…
for (const item of items) {
  const { tx, amount } = await EconomyLedger.burnFraudulent(…, dbTransaction);   // :81
}
await Promise.all([...touchedCurrencyIds].map((id) => EconomyMetrics.refresh(id, dbTransaction)));  // :87
```

Une transaction Sequelize est adossée à **une seule connexion**. Lancer
plusieurs requêtes en parallèle dessus ne les parallélise pas : le pilote les
met en file. Le `Promise.all` n'apporte donc aucun gain — mais il a un coût bien
réel : chaque `refresh()` appelle `purchaseVolume24h`, qui s'exécute **hors
transaction** (B1-01, point c). Le `Promise.all` déclenche donc N demandes de
connexion **simultanées** sur un pool de 10, alors qu'une connexion est déjà
prise par la transaction.

Avec 10 monnaies touchées, le pool est vidé d'un coup, par une seule requête
administrateur.

**Correctif.**
- Remplacer le `Promise.all` par une boucle séquentielle : aucun gain perdu,
  pic de connexions ramené à 1.
- Corriger `purchaseVolume24h` (B1-01, point 1) : le pic disparaît alors
  complètement.
- Plafonner `items` (route d'administration, donc moins critique, mais gratuit).

### Une lacune de mon balayage, que je signale

Le balayage automatique de B1-04 cherchait les appels de fonctions en
**minuscule** (`await maFonction(...)`). Il n'a donc **pas** vu
`UserFollow.isFollowing(...)` du point (a), qui est une méthode statique portée
par une classe de modèle. Le chiffre « 6 sites » de B1-04 est donc un plancher,
pas un total : les méthodes statiques de modèles qui n'acceptent pas de
transaction échappent à ce comptage. `UserFollow.isFollowing`
(`src/models/UserFollow.js`) est la première ; une revue de toutes les méthodes
statiques des modèles, sous l'angle « accepte-t-elle une transaction ? », serait
le complément à faire.

### Vérifié SAIN dans le même balayage

`src/services/policiercongo/messagingManager.js:30-65`
(`getOrCreateDirectConversation`) contient bien une boucle avec `await` dans une
transaction, mais **toutes** ses requêtes reçoivent `transaction: tx`, et sa
boucle est bornée par un `where` qui filtre déjà sur les deux participants
concernés :

```js
const conversations = await Conversation.findAll({
  where: { type: 'direct' },
  include: [{ model: ConversationParticipant, as: 'participants',
              where: { user_id: { [Op.in]: [POLICE_ACCOUNT_ID, targetUserId] } },
              required: true }],
  transaction: tx
});
```

**C'est la bonne version de `findExactDirectConversation`** (R3-02,
`messageRoutes.js:489`), qui, lui, charge toute la table faute de ce `where`
imbriqué. Les deux fonctions résolvent le même problème dans le même dépôt ;
l'une le fait bien. Le correctif de R3-02 peut donc être copié d'ici plutôt
qu'inventé.

`src/services/policiercongo/InstructionManager.js:55` et `:73` : boucles bornées
par un fichier de configuration, toutes requêtes dans la transaction. Sain.

**Gravité :** moyenne pour (a) — route ordinaire, mais plafond fixé par le
client ; faible pour (b) — route d'administration, peu appelée.

---

## B1-07 — **Aucune** des 42 méthodes statiques de modèles n'accepte de transaction

**Où :** `src/models/` — inventaire complet ci-dessous.

J'ai passé en revue toutes les méthodes `static async` des modèles qui exécutent
une requête. **Les 42 sont dans le même cas : ni leur signature ni leur corps ne
mentionne `transaction`.** Elles sont donc, par construction, incapables de
participer à la transaction de leur appelant : chaque appel emprunte
nécessairement une connexion supplémentaire au pool.

| Fichier | Méthodes concernées |
|---|---|
| `TweetLike.js` | `getTweetLikes` `:6`, `getUserLikedTweets` `:29`, `hasUserLikedTweet` `:56`, `countTweetLikes` `:67`, `countLikesForTweets` `:81`, `likedTweetIdsForUser` `:102`, `countUserLikedTweets` `:116` |
| `TweetRetweet.js` | `getTweetRetweets` `:6`, `getUserRetweets` `:29`, `hasUserRetweetedTweet` `:56`, `countTweetRetweets` `:67`, `countRetweetsForTweets` `:78`, `retweetedTweetIdsForUser` `:96`, `countUserRetweets` `:110` |
| `UserFollow.js` | `isFollowing` `:34`, `getFollowing` `:46`, `getFollowers` `:73`, `countFollowing` `:100`, `countFollowers` `:107`, `getFollowSuggestions` `:114`, `getMutualFollowers` `:226` |
| `Notification.js` | `getUserNotifications` `:14`, `countUnreadNotifications` `:62`, `markAllAsRead` `:72`, `createNotification` `:88`, et les 7 aides `create*Notification` `:137`-`:236` |
| `Tweet.js` | `searchTweets` `:60`, `getUserTweets` `:125`, `getUserFeed` `:160`, `countRepliesForTweets` `:214` |
| `User.js` | `searchUsers` `:70`, `getPopularUsers` `:88` |
| `MonetizationMetrics.js` | `getEligibleTweets` `:47`, `getUserTotalRevenue` `:112`, `simulateEngagement` `:173` |
| `DailySpotlight.js` | `getForDate` `:11` |

**Ce que cela vaut aujourd'hui.** J'ai ensuite cherché lesquelles sont réellement
appelées **depuis l'intérieur** d'une transaction, dans tout `src/` et pour les
deux formes de transaction. Il n'y en a que **deux** :

- `src/routes/messageRoutes.js:847` — `UserFollow.isFollowing(pid, userId)`,
  dans la boucle non bornée de création de groupe (constat B1-06, point a) ;
- `src/routes/messageRoutes.js:1002` — `UserFollow.isFollowing(targetUserId,
  userId)`, dans `POST /conversations/:conversationId/participants` (transaction
  ouverte `:948`), pour décider si le membre ajouté est en `accepted` ou en
  `pending`.

Le second est un cas isolé : une requête supplémentaire par ajout de membre.
C'est faible en soi — mais c'est aussi, comme en B1-04, une **décision prise sur
un instantané différent** de celui où elle est écrite.

**Le vrai enjeu n'est donc pas le nombre de sites, c'est la surface.** Ces 42
méthodes forment l'interface d'accès aux données la plus commode du dépôt ;
c'est celle qu'on emploie naturellement. Aucune ne peut aujourd'hui être
utilisée depuis une transaction sans emprunter une connexion. Le prochain
développeur qui appellera `Tweet.getUserFeed` ou `Notification.createNotification`
depuis un bloc transactionnel réintroduira le défaut, et rien dans le code ne
l'en avertira.

**Correctif.** Uniforme et mécanique — ajouter un paramètre optionnel et le
propager :

```js
static async isFollowing(followerId, followingId, transaction = null) {
  const follow = await this.findOne({
    where: { follower_id: followerId, following_id: followingId, status: 'active' },
    transaction,
  });
  return !!follow;
}
```

`transaction: null` est le comportement actuel de Sequelize : **les appels
existants ne changent pas**. La modification est donc rétrocompatible sur les 42
méthodes, et peut se faire progressivement.

Priorité : `UserFollow.isFollowing` (les deux sites connus),
`Notification.createNotification` (fonction d'écriture, la plus susceptible
d'être appelée depuis une transaction), puis les compteurs.

**Filet de sécurité recommandé.** Un test qui échoue si une méthode statique de
modèle exécutant une requête n'accepte pas `transaction` — le balayage qui a
produit le tableau ci-dessus tient en une trentaine de lignes et peut servir
tel quel de garde-fou.

**Gravité :** faible aujourd'hui (2 sites, tous deux mineurs), mais c'est le
constat qui explique pourquoi B1-02, B1-03, B1-04 et B1-06 existent : la voie
d'accès la plus naturelle du dépôt ne sait pas participer à une transaction.

---

## B1-08 — Ordre de verrouillage **incohérent** dans le grand livre : trois interblocages possibles

**Où :** `src/economy/ledger.js`, méthode `lockWallet` (`:105`, `FOR UPDATE`),
appelée 18 fois. L'ordre des appels diffère d'un chemin à l'autre.

### Le tableau des ordres

| Méthode | Ligne(s) | Ordre de verrouillage |
|---|---|---|
| `spendToTreasury` | `:241` puis `:247` | **utilisateur**, puis trésorerie |
| `rewardFromTreasury` | `:304` puis `:316` | **trésorerie**, puis utilisateur |
| `transferP2P` | `:406`, `:411`, `:412` | émetteur, destinataire, trésorerie — **dans l'ordre des arguments** |
| `setBalance` (débit) | `:622` puis `:633` | utilisateur, puis trésorerie |
| conversion de monnaie | `:699` puis `:705` | monnaie source, puis destination — **ordre des arguments** |
| (`:861` / `:872`) | | utilisateur, puis trésorerie |

Un interblocage survient dès que deux transactions demandent les mêmes verrous
**dans un ordre différent**. Trois cas concrets, tous atteignables avec des
opérations parfaitement normales :

### Cas 1 — dépense et récompense sur le même compte (le plus probable)

- T1 (`spendToTreasury`, utilisateur A) : verrouille A, puis demande la
  trésorerie.
- T2 (`rewardFromTreasury`, utilisateur A) : verrouille la trésorerie, puis
  demande A.

Chacune attend le verrou que l'autre détient. C'est le cas le plus facile à
atteindre, parce que la **trésorerie est commune à toutes les opérations** : il
suffit qu'un achat et une récompense concernant le même compte se croisent —
par exemple un utilisateur qui achète quelque chose au moment où un versement de
concours ou une récompense de minage lui parvient.

### Cas 2 — transferts croisés entre deux personnes

- T1 (`transferP2P` A → B) : verrouille A, puis B.
- T2 (`transferP2P` B → A) : verrouille B, puis A.

L'ordre suit les arguments, donc s'inverse mécaniquement quand le sens du
transfert s'inverse.

### Cas 3 — conversions croisées de monnaie pour un même utilisateur

`:699`/`:705` verrouillent `fromCurrencyId` puis `toCurrencyId`. Deux
conversions inverses simultanées (NF → EUR interne et EUR interne → NF) pour le
même compte se bloquent de la même façon.

**Ce qui se passe réellement.** PostgreSQL détecte les interblocages et tue
l'une des deux transactions avec `deadlock detected`. Ce n'est donc pas un
blocage définitif — mais c'est **une opération d'argent qui échoue sans raison
compréhensible**, de façon intermittente et non reproductible, et d'autant plus
souvent que la plateforme est active. Du point de vue de l'utilisateur : « le
paiement n'a pas marché, réessaie ». Du point de vue des journaux : une erreur
Postgres brute, à recouper avec la section B2.

**La solution est déjà écrite dans ce dépôt.** `usernameMarketService.js:374-379`
résout exactement ce problème, et le commentaire l'explique :

> « Les deux comptes sont verrouillés dans un ordre déterministe (par id) :
> deux achats croisés simultanés se bloqueraient sinon mutuellement. »

```js
const ids = [String(listing.seller_id), String(buyerId)].sort();
const locked = await User.findAll({
  where: { id: { [Op.in]: ids } },
  order: [['id', 'ASC']],
  transaction: t,
  lock: t.LOCK.NO_KEY_UPDATE,
});
```

Le grand livre n'applique pas cette règle.

**Correctif.** Introduire une méthode unique qui verrouille **plusieurs**
portefeuilles dans un ordre total, et l'utiliser partout :

```js
static async lockWallets(pairs, dbTransaction) {       // pairs: [{userId, currencyId}, …]
  const keys = pairs
    .map(p => ({ ...p, k: `${p.userId}:${p.currencyId}` }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const out = new Map();
  for (const p of keys) {
    out.set(p.k, await this.lockWallet(p.userId, p.currencyId, dbTransaction));
  }
  return out;
}
```

Puis, dans chaque méthode, remplacer les appels successifs par un seul appel
listant tous les portefeuilles concernés :

```js
// rewardFromTreasury
const w = await this.lockWallets(
  [{ userId: TREASURY_USER_ID, currencyId }, { userId, currencyId }],
  dbTransaction
);
```

L'ordre d'acquisition devient identique quel que soit le chemin, et les trois
cas disparaissent.

**Point de vigilance :** `rewardFromTreasury` lit le solde de la trésorerie
(`:305`) **avant** de verrouiller le portefeuille de l'utilisateur, pour
échouer tôt si les fonds manquent. En triant les verrous, cette vérification
doit être déplacée **après** l'acquisition des deux verrous. Cela ne change ni
le résultat ni la sémantique — seulement le moment du contrôle.

**Vérification recommandée avant/après :** interroger
`pg_stat_database.deadlocks` sur la base de production. Si le compteur est
non nul, ces trois cas en sont la cause la plus probable, et il doit retomber à
zéro après correction. C'est une mesure directe, immédiate, qui confirmera ou
infirmera ce constat mieux que toute lecture de code.

**Amplificateur : le casino.** `src/services/casinoService.js` exécute, dans une
**même** transaction, `spendToTreasury` (mise) puis `rewardFromTreasury` (gain)
— quatre fois, pour les quatre jeux (`:210`/`:220`, `:283`/`:293`,
`:351`/`:361`, `:411`/`:421`). L'ordre y est donc utilisateur → trésorerie. Or
c'est de loin le chemin économique le plus fréquemment emprunté de la
plateforme : chaque tour de roue, chaque lancer de dés prend le verrou de la
trésorerie. Toute récompense concurrente (minage, concours, versement
automatique), qui verrouille dans l'ordre inverse, est un candidat au cas 1.
Si `pg_stat_database.deadlocks` est non nul, c'est très probablement ici.

**Gravité :** élevée. Ce sont des échecs d'opérations d'argent, intermittents,
non reproductibles en test, et dont la fréquence augmente avec l'activité.

---

## Vérifié et trouvé SAIN

Ce qui a été regardé dans cette section et **n'appelle aucun correctif** — avec,
à chaque fois, la raison, parce que plusieurs de ces exemples sont les modèles à
copier pour corriger les constats ci-dessus.

**Aucun appel réseau sous verrou.** Balayage automatisé de tout `src/`, sur les
deux formes de transaction, à la recherche de `fetch`/`axios` entre l'ouverture
et le `COMMIT` : **zéro résultat**. Le motif le plus redouté de cette section
n'existe pas dans ce dépôt.

**Aucun appel de modèle sans `transaction:` dans un bloc transactionnel.**
Balayage sur les deux formes : **zéro résultat**. Là où le code écrit
directement une requête à l'intérieur d'une transaction, il lui passe toujours
la transaction. Les fuites viennent uniquement des fonctions intermédiaires
(B1-03, B1-04, B1-06, B1-07).

**`usernameMarketService.js:374-379` — l'ordre de verrouillage déterministe.**
Les deux comptes sont triés par identifiant avant d'être verrouillés, et le
choix de `NO KEY UPDATE` plutôt que `FOR UPDATE` est justifié par un commentaire
qui décrit l'incident exact qu'il évite. **C'est la référence pour corriger
B1-08.**

**`gAuthService.js:317-319` — même discipline.** `NO_KEY_UPDATE` explicitement
choisi, avec la raison : « un appel au grand livre suit dans cette même
transaction, et `FOR UPDATE` se bloquerait sur son insert de vérification de clé
étrangère sur une autre connexion ».

**`economy/ledger.js:155`, `:228`, `:395`, `:687` — l'autorisation avant le
verrou.** `transactionAuthorizationService.authorize()` est systématiquement
appelé **avant** le premier `lockWallet`. Aucun verrou n'est donc tenu pendant
l'autorisation. L'exemption `INTERNAL_CONVERSION_EXEMPTION` (`:684`) est
elle-même documentée comme servant à ne pas « redemander une autorisation qui se
bloquerait sur nos propres verrous ». La discipline est là ; c'est le service
d'autorisation lui-même qui ne la suit pas (B1-02).

**`newEconomyService.js:371-415` (`submitMiningProof`) — la bonne granularité.**
`FOR UPDATE` sur la ligne du round de minage, c'est-à-dire sur l'objet réellement
disputé. Le `findByPk(userId, …)` de la ligne 401 est délibérément **sans**
`lock`. C'est le contre-exemple exact du précédent connu.

**`contestService.js:278-282` — le verrou optimiste.**
`UPDATE contests SET status='drawing' WHERE id=… AND status='open'` puis test du
nombre de lignes touchées : deux exécutions concurrentes du cron ne peuvent pas
tirer le même concours deux fois, sans aucun verrou explicite. Élégant et
correct.

**`communityModerationService.js` — ordre de verrouillage cohérent.** Les trois
chemins de verdict (`executeSanction` `:339`/`:367`, `applyViolationMinimum`
`:453`, `applyCompliantVerdict` `:490`/`:513`) verrouillent toujours
**`Tweet` puis `User`**, jamais l'inverse. Les chemins de vote (`:644`, `:1348`,
`:1480`, `:1490`) verrouillent toujours **l'item puis l'assignation**. Et
`hasReportedTweet(userId, item.tweet_id, tx)` (`:1504`) reçoit bien la
transaction. Aucun interblocage possible entre ces chemins.

**Les notifications sont envoyées hors transaction.** `notifySanction`
(`communityModerationService.js:~575`) est une fonction distincte, appelée après
coup ; `Notification.createNotification` n'est appelé depuis **aucun** bloc
transactionnel (vérifié par le balayage de B1-07). C'est important : cette
fonction déclenche un envoi push sans délai d'attente (constat R4-01), et le
faire sous verrou aurait été le pire cas de cette section.

**Les émissions Socket.io sont après `COMMIT`.** Vérifié dans
`messageRoutes.js` (`POST /direct/:userId`, `POST /groups`) : aucun effet de
bord externe n'est déclenché avant la validation de la transaction.

**`policiercongo/messagingManager.js:30-65`** — boucle avec `await` dans une
transaction, mais toutes les requêtes reçoivent `tx` et le `where` imbriqué
borne le résultat. C'est aussi **la version correcte de R3-02**.

---

## Récapitulatif

| # | Objet | Effet | Correctif |
|---|---|---|---|
| B1-02 | anti-fraude hors transaction | interblocage du pool (10 conn., 60 s), **incident déjà survenu** | propager `dbTransaction` |
| B1-08 | ordre de verrouillage incohérent | 3 interblocages, opérations d'argent qui échouent au hasard | verrouiller dans un ordre trié |
| B1-05 | tirage de concours | trésorerie verrouillée pendant une transaction non bornée | écriture en lot, sortir ce qui peut l'être |
| B1-01 | `EconomyMetrics.refresh` | verrou global + `SUM` de toute la table sous ce verrou | compteur incrémental, propager la transaction |
| B1-03 | `POST /messages/direct/:userId` | 3 connexions par requête, 4 requêtes vident le pool | appeler les contrôles **avant** la transaction |
| B1-06 | boucles non bornées | N requêtes hors `tx`, plafond fixé par le client | plafonner + une seule requête groupée |
| B1-04 | gardes de groupe | 4 connexions de plus ; contrôle d'accès hors instantané | paramètre `transaction` |
| B1-07 | 42 méthodes statiques de modèles | aucune ne sait participer à une transaction | paramètre optionnel, rétrocompatible |

**Les trois premiers gestes, par rentabilité :**

1. **B1-01, point 1 + B1-02, point 1** — propager la transaction à
   `purchaseVolume24h` et à `_claimAuthorization`. Quelques lignes, et les deux
   chemins connus vers l'interblocage de pool disparaissent. En attendant,
   `DB_POOL_MAX=25` et `DB_POOL_ACQUIRE=8000` (deux variables d'environnement)
   éloignent le seuil et raccourcissent la panne quand elle survient.
2. **B1-08** — trier les verrous de portefeuille. Une fonction `lockWallets`
   d'une quinzaine de lignes, puis la substituer dans les six méthodes du grand
   livre. **Avant de commencer, relever `SELECT deadlocks FROM pg_stat_database` :**
   la mesure dit tout de suite si le problème est déjà réel, et sert de
   vérification après correction.
3. **B1-05** — remplacer la boucle de `save()` du tirage de concours par deux
   `UPDATE` groupés. La durée du verrou sur la trésorerie cesse de dépendre du
   nombre de participants.

**Deux causes racines, pas huit défauts :**

- **« Une fonction appelée depuis une transaction ne reçoit pas cette
  transaction. »** B1-01, B1-02, B1-03, B1-04, B1-06 et B1-07 en découlent
  tous. La conséquence est toujours la même : une connexion de plus empruntée à
  un pool de 10, et une lecture faite dans un autre instantané. La règle à poser
  est simple — *toute fonction susceptible d'être appelée depuis une transaction
  accepte et propage `transaction`* — et elle est déjà respectée partout où le
  code écrit ses requêtes directement.
- **« Le verrou est plus large, ou plus long, que ce qu'il protège. »** B1-01
  (point b), B1-05 et B1-08. La bonne pratique existe déjà dans le dépôt
  (`submitMiningProof`, `usernameMarketService`) : elle n'a simplement pas été
  généralisée au grand livre.

**Recoupements.** B1-03 recoupe R3-02 (la transaction est longue *parce que*
`findExactDirectConversation` scanne toute une table — corriger R3-02 raccourcit
B1-03) ; B1-01 point b recoupe R2 (agrégat non indexé) ; B1-04 ouvre une piste
S2 (contrôle d'accès de groupe évalué hors transaction) ; B1-02 ouvre une piste
S3 (fenêtre de 15 secondes pendant laquelle une autorisation existe pour une
opération annulée — rejeu d'opération créditrice).
