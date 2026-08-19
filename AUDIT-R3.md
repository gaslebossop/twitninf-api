# R3 — Pagination et taille des réponses

> Section 3 de l'audit `twitninf-api`. Priorité **RAPIDITÉ**.
>
> On cherche ici : les requêtes qui ramènent des lignes **sans `LIMIT`**, les
> listes renvoyées **en entier** au client, les `SELECT *` là où trois colonnes
> suffisent, et les objets **sur-sérialisés** (charge utile gonflée par des
> champs que le client n'affiche jamais).
>
> Chaque constat est vérifié dans le code avant d'être écrit. Quand une
> incertitude subsiste, elle est dite explicitement. Les constats sont classés
> par gain décroissant.

---

## R3-01 — `/api/recommendations` : toutes les réponses de 10 tweets chargées pour en garder 3

**Où :** `src/routes/recommendationRoutes.js:264`

La fonction `buildSimilarityRecommendations()` sert les quatre routes de
recommandation (`/api/recommendations`, `/following`, `/algorithm/:algorithm`,
`/smart`). Étape « 3.c » : quand le moteur n'a remonté aucune réponse dans la
page, le code va en chercher une lui-même.

```js
const potentialReplies = await Tweet.findAll({
  where: { parent_tweet_id: { [Op.in]: Array.from(recommendedParentIds) }, deleted_at: null },
  include: [ /* author + originalTweet + son author */ ],
  order: [['created_at', 'ASC']],
});   // ← aucun `limit`
```

**Ce qui ne va pas.** `recommendedParentIds` contient jusqu'à 10 identifiants
(la limite de la route est bien bornée : `Math.min(parseInt(limit) || 10, 10)`,
ligne 528). La requête ramène donc **l'intégralité des réponses de ces 10
tweets**, chacune jointe à son auteur, à son tweet original et à l'auteur de
celui-ci. Puis, lignes 282-286 :

```js
for (const reply of potentialReplies) {
  if (!extraRepliesMap.has(reply.parent_tweet_id)) {
    extraRepliesMap.set(reply.parent_tweet_id, reply);   // ← la 1re seulement
  }
}
```

Une seule réponse par parent est retenue, et le reste du code n'en insère que
**3 au maximum** (`repliesCount < 3`). Tout le reste est jeté.

**Effet concret.** Le volume ramené est celui du tweet le plus commenté de la
page, pas celui de ce qu'on affiche. Sur un fil ordinaire (10 tweets à ~5
réponses) c'est ~50 lignes pour en garder 3 : négligeable. Mais il suffit qu'un
seul tweet viral entre dans la page — 5 000 réponses — pour que la requête
ramène 5 000 lignes × 4 tables jointes, soit plusieurs Mo désérialisés en
objets Sequelize, **pour en garder une**. Et comme c'est le chemin de
recommandation, ce tweet viral est précisément celui que le moteur pousse à
tout le monde : la requête coûteuse est servie à *tous* les lecteurs
simultanément, pas à un seul malchanceux.

**Correctif.** Une seule réponse par parent est nécessaire : c'est exactement
un `DISTINCT ON` PostgreSQL.

```sql
SELECT DISTINCT ON (parent_tweet_id) *
FROM tweets
WHERE parent_tweet_id = ANY($1) AND deleted_at IS NULL
ORDER BY parent_tweet_id, created_at ASC
```

À défaut, un correctif d'une ligne qui supprime déjà l'essentiel du risque :
ajouter `limit: recommendedParentIds.size * 3` à l'appel `findAll` — on ne peut
de toute façon en garder qu'une par parent, et jamais plus de 3 en tout. Le
plafond devient borné par la page au lieu de l'être par la popularité du tweet.

**Gain :** requête bornée à quelques dizaines de lignes au lieu de plusieurs
milliers, sur un chemin de fil servi à chaque lecteur.

---

## R3-02 — `POST /api/messages/direct/:userId` : **toute la table des conversations** chargée pour en trouver une

**Où :** `src/routes/messageRoutes.js:489` (fonction `findExactDirectConversation`),
appelée depuis `src/routes/messageRoutes.js:655`.

```js
async function findExactDirectConversation(userA, userB, transaction) {
  const candidates = await Conversation.findAll({
    where: { type: 'direct' },          // ← seul filtre : le type
    include: [{ model: ConversationParticipant, as: 'participants', required: true }],
    transaction
  });
  // …puis, en JavaScript :
  for (const conv of candidates) {
    const ids = (conv.participants || []).map(p => String(p.user_id));
    if (ids.length !== 2) continue;
    …
  }
}
```

**Ce qui ne va pas.** Le seul prédicat SQL est `type = 'direct'`. Ni `userA` ni
`userB` n'apparaissent dans le `where`. La base renvoie donc **toutes les
conversations directes de toute la plateforme**, chacune jointe à ses
participants, et le filtrage sur les deux utilisateurs concernés est fait
ensuite, en JavaScript, dans une boucle.

**Effet concret.** Le coût de l'ouverture d'une conversation est proportionnel
au nombre total de conversations de la plateforme, pas au nombre de
conversations de l'utilisateur. À 100 000 conversations directes, un utilisateur
qui envoie un premier message à quelqu'un déclenche un `Seq Scan` de
`conversations` joint à `conversation_participants` (~200 000 lignes),
désérialisé en 300 000 objets Sequelize, **pour en retenir une seule**. Le coût
croît linéairement avec le succès du produit : c'est une route dont la latence
augmente toute seule, sans qu'aucun code ne change.

Deux aggravations :

1. La requête tourne **à l'intérieur de la transaction** ouverte pour créer la
   conversation (`transaction: tx`). Toute la durée du scan est du temps de
   transaction ouverte — voir aussi la section B1.
2. Elle est sur le chemin d'**écriture** le plus courant de la messagerie
   (premier message à un utilisateur), pas sur un écran d'administration.

**Correctif.** La question « existe-t-il une conversation directe dont les
participants sont exactement {A, B} ? » se répond en une requête bornée, par
auto-jointure sur la table des participants :

```sql
SELECT p1.conversation_id
FROM conversation_participants p1
JOIN conversation_participants p2 ON p2.conversation_id = p1.conversation_id
JOIN conversations c ON c.id = p1.conversation_id
WHERE p1.user_id = :a AND p2.user_id = :b AND c.type = 'direct'
GROUP BY p1.conversation_id
HAVING COUNT(DISTINCT p1.user_id) = 1
LIMIT 1;
```

En Sequelize, l'équivalent minimal : partir de `ConversationParticipant`
filtré sur `user_id = userA`, joindre `Conversation` sur `type='direct'`, et ne
garder que les conversations dont la liste de participants contient `userB` —
la requête est alors bornée par le nombre de conversations de `userA` (quelques
dizaines à quelques centaines), pas par celui de la plateforme. Un index sur
`conversation_participants(user_id, conversation_id)` rend la recherche
immédiate.

**Gain :** de O(conversations de la plateforme) à O(conversations de
l'utilisateur) sur un chemin d'écriture chaud. C'est le constat au plus fort
effet de levier de cette section.

---

## R3-03 — `GET /api/messages/conversations` : boîte de réception **sans aucune pagination**

**Où :** `src/routes/messageRoutes.js:517-543`

```js
const memberships = await ConversationParticipant.findAll({
  where: { user_id: userId },
  include: [{
    model: Conversation, as: 'conversation',
    include: [
      { model: ConversationParticipant, as: 'participants',
        include: [{ model: User, as: 'user', attributes: [ /* 9 colonnes */ ] }] },
      { model: Message, as: 'messages', limit: 1, separate: true,
        order: [['created_at', 'DESC']],
        include: [{ model: User, as: 'sender', attributes: ['id','username','full_name'] }] }
    ]
  }],
  order: [['updated_at', 'DESC']]
});          // ← ni `limit`, ni `offset`
```

La route ne lit **ni `req.query.limit` ni `req.query.offset`** : il n'y a pas de
pagination du tout, ni côté SQL ni côté API. Le client reçoit systématiquement
l'intégralité de sa boîte de réception.

**Ce qui ne va pas — trois effets cumulés :**

1. **Charge utile non bornée.** Chaque conversation est sérialisée avec la liste
   complète de ses participants, chacun avec 9 colonnes de profil
   (`profile_customization` compris, qui est un JSONB potentiellement gros — cf.
   R3-06). Un groupe de 200 membres est donc renvoyé avec ses 200 profils
   complets, à chaque ouverture de la messagerie, alors que l'écran n'affiche
   que 2 ou 3 avatars empilés.
2. **`separate: true` = une requête par conversation.** Le dernier message est
   récupéré par une requête distincte pour chaque conversation. Un utilisateur
   avec 200 conversations déclenche **200 requêtes** `SELECT … FROM messages
   WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`, plus la requête
   principale. C'est le prix à payer pour un `limit: 1` par groupe, mais il n'est
   pas borné : il croît avec le nombre de conversations, sans plafond.
3. **Le filtrage se fait après.** Les invitations en attente ou refusées sont
   écartées en JavaScript (`return null` puis `.filter(Boolean)`), donc payées
   en SQL, en réseau et en mémoire avant d'être jetées.

**Effet concret.** Pour un utilisateur ordinaire (20 conversations) : ~21
requêtes, réponse de quelques dizaines de Ko — acceptable. Pour un compte actif
ou un modérateur (300 conversations, dont des groupes) : **~300 requêtes** et
une réponse de plusieurs Mo, à chaque ouverture de l'onglet messages, sans
possibilité pour le client de demander moins. La latence de cet écran est
proportionnelle à l'ancienneté du compte : elle se dégrade toute seule.

**Correctif.**

- Paginer : `limit` (défaut 20, plafond 50) + `offset`, validés par
  `query('limit').optional().isInt({ min: 1, max: 50 })` comme le fait déjà
  `tweetRoutes.js:182`. C'est le correctif qui compte : il borne d'un coup les
  trois effets ci-dessus.
- Déplacer le filtrage des invitations dans le `where` SQL plutôt qu'en
  post-traitement, pour que la page renvoyée soit pleine.
- Ne sérialiser que les participants réellement affichés (les 3 premiers +
  un compteur), et sur 3 colonnes (`id`, `username`, `avatar`) au lieu de 9.

**Gain :** de ~300 requêtes et plusieurs Mo à ~21 requêtes et quelques dizaines
de Ko pour les comptes les plus chargés, sur l'écran d'entrée de la messagerie.

---

## R3-04 — `GET /api/messages/invitations` : toute la messagerie chargée pour afficher 0 à 2 invitations

**Où :** `src/routes/messageRoutes.js:1844-1883`

```js
const memberships = await ConversationParticipant.findAll({
  where: { user_id: userId },                    // ← aucun filtre sur l'invitation
  include: [{ model: Conversation, as: 'conversation',
    include: [{ model: ConversationParticipant, as: 'participants',
      include: [{ model: User, as: 'user', attributes: [ /* 9 colonnes */ ] }] }] }]
});                                              // ← ni `limit`, ni `offset`

const directInvitations = memberships
  .map(m => m.conversation).filter(Boolean)
  .filter(conv => conv.type === 'direct')
  .map(conv => ({ conv, inv: getInvitationMeta(conv) }))
  .filter(({ inv }) => inv.status === 'pending' && sameId(inv.to, userId))   // ← le vrai filtre, en JS
  …
```

**Ce qui ne va pas.** La requête ne filtre que sur `user_id`. Tout le tri utile
— *type de conversation*, *statut de l'invitation*, *destinataire de
l'invitation* — est fait ensuite en JavaScript, sur des objets déjà construits.
Le serveur charge donc **l'intégralité de la messagerie de l'utilisateur**
(toutes ses conversations, tous leurs participants, tous leurs profils) pour
n'en garder, dans le cas normal, **aucune ou une poignée**.

C'est le même volume que R3-03, mais avec un rapport utile/chargé bien pire :
sur la boîte de réception on renvoie ce qu'on a chargé ; ici on jette ~100 %.

**Effet concret.** Un compte avec 300 conversations paye la sérialisation de 300
conversations et de tous leurs participants — plusieurs Mo d'objets Sequelize —
pour répondre le plus souvent `{"invitations": []}`. Le coût est payé à chaque
appel, et cet écran (le badge « invitations ») est typiquement rafraîchi au
chargement de l'application, voire par sondage périodique — à vérifier côté
client, je ne peux pas le confirmer depuis ce dépôt.

**Correctif.** Le statut d'invitation vit dans `conversations.metadata` (JSONB),
ce qui explique le filtrage en JS — mais PostgreSQL sait très bien le faire :

```js
where: { user_id: userId },
include: [{
  model: Conversation, as: 'conversation', required: true,
  where: {
    [Op.or]: [
      { metadata: { invitation: { status: 'pending', to: String(userId) } } },   // direct
      sequelize.literal(`"conversation"."metadata" #>> '{group_invitations,${userId},status}' = 'pending'`)
    ]
  }
}]
```

Le prédicat devient SQL, la réponse ne contient que les invitations réelles, et
un index GIN sur `conversations(metadata)` (ou, plus efficace, une colonne
dédiée `invitation_status` + `invitation_to`) rend la recherche immédiate.
Ajouter aussi `limit`/`offset` comme filet de sécurité.

**Note d'architecture.** Stocker un statut qui sert de *prédicat de recherche*
dans un JSONB est la cause racine des deux constats : le code n'a alors plus
d'autre choix que de tout charger. Deux colonnes indexées régleraient R3-04 et
la moitié de R3-03.

**Gain :** de « toute la messagerie de l'utilisateur » à « les invitations en
attente », sur une route appelée au démarrage de l'application.

---

## R3-05 — La liste d'abonnements matérialisée en clause `IN` : ~190 Ko de SQL par page de fil

**Où (16 sites) :** `src/models/Tweet.js:170` (`getUserFeed`),
`src/models/UserFollow.js:118` (`getFollowSuggestions`), `:230`, `:234`,
`src/routes/storyRoutes.js:211`, `src/routes/userRoutes.js:425`,
`src/utils/privateAccountVisibility.js:45`, `src/services/recommendationEngine.js:465`,
`:615`, `:1731`, `:2548`, `src/services/smartRecommendationEngine.js:1182`,
`:1750`, `:1755`, `src/services/ultraRecommendationEngine.js:952`,
`src/services/userSimilarityService.js:167`.

Le motif est partout identique :

```js
const following = await UserFollow.findAll({
  where: { follower_id: userId, status: 'active' },
  attributes: ['following_id']          // ← aucun `limit`
});
const followingIds = following.map(f => f.following_id);
followingIds.push(userId);

return this.findAll({
  where: { user_id: { [Op.in]: followingIds }, parent_tweet_id: null },
  …
});
```

**Ce qui ne va pas.** La liste des comptes suivis est ramenée **entière** dans
le processus Node, puis ré-injectée dans la requête suivante sous forme de
littéral `IN (…)`. La base sait faire cette jointure elle-même ; ici elle la
reçoit comme une constante géante.

**Effet concret, chiffré.** Un `following_id` est un UUID : sérialisé dans le
SQL, il pèse 38 octets (`'…',`). Pour un compte suivant

| abonnements | taille du littéral `IN` | |
|---|---|---|
| 100 | ~3,8 Ko | négligeable |
| 1 000 | ~38 Ko | perceptible |
| 5 000 | **~190 Ko** | sensible |
| 20 000 | **~760 Ko** | grave |

Ces 190 Ko sont, **à chaque page de fil** : transférés au serveur PostgreSQL,
analysés par son parseur, et replanifiés (un littéral différent à chaque appel
interdit toute réutilisation de plan préparé). Deux requêtes au lieu d'une, dont
la première est une lecture non bornée qui grossit avec la carrière du compte.
Et cela vaut pour `Tweet.getUserFeed`, c'est-à-dire le chemin le plus appelé de
l'API.

**Le cas le plus grave est `getFollowSuggestions` (`UserFollow.js:118`) :** le
littéral y est passé en `NOT IN`.

```js
const following = await this.findAll({ where: { follower_id: userId }, attributes: ['following_id'] });
const followingIds = following.map(f => f.following_id);
return User.findAll({ where: { id: { [Op.notIn]: followingIds } }, … });
```

Un `NOT IN` sur une longue liste de littéraux ne peut pas être transformé en
anti-jointure par le planificateur : PostgreSQL évalue l'appartenance ligne à
ligne sur `users`. Un compte suivant 5 000 personnes provoque donc un parcours
de la table `users` avec 5 000 comparaisons par ligne. La suggestion d'abonnés
est aussi la fonctionnalité dont les utilisateurs les plus actifs — donc ceux
qui ont la plus longue liste — se servent le plus.

**Correctif.** Remplacer la matérialisation par une sous-requête, ce qui rend la
double requête inutile et laisse le planificateur choisir la jointure :

```js
// au lieu de : user_id: { [Op.in]: followingIds }
user_id: {
  [Op.in]: sequelize.literal(
    `(SELECT following_id FROM user_follows WHERE follower_id = :uid AND status = 'active'
      UNION ALL SELECT :uid)`
  )
}
```

Pour `getFollowSuggestions`, préférer `NOT EXISTS` à `NOT IN` — c'est la forme
que PostgreSQL sait transformer en anti-jointure par hachage :

```sql
SELECT u.* FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_follows f WHERE f.follower_id = :uid AND f.following_id = u.id
) AND u.id <> :uid
ORDER BY … LIMIT :limit
```

L'index nécessaire (`user_follows(follower_id, following_id)`) est le même que
celui déjà utilisé par la lecture actuelle : le correctif ne coûte aucun index
supplémentaire.

**À vérifier avant de généraliser :** les 16 sites n'ont pas le même poids. Les
deux à traiter en premier sont `Tweet.js:170` (fil) et `UserFollow.js:118`
(suggestions) ; les moteurs de recommandation, eux, tournent souvent hors du
chemin de la requête — je n'ai pas vérifié site par site lesquels sont
synchrones, et je le signale plutôt que de l'affirmer.

**Gain :** une requête au lieu de deux, un plan réutilisable, et une taille de
requête constante au lieu de proportionnelle au nombre d'abonnements — sur le
chemin de fil.

---

## R3-06 — `GET /api/ads/stats` : une jointure entière chargée puis **jamais lue**

**Où :** `src/routes/adRoutes.js:781`

```js
const campaigns = await AdCampaign.findAll({
  where: { user_id: userId },
  include: [{ model: Advertisement, as: 'advertisements' }]   // ← ni `attributes`, ni `limit`
});

let totalImpressions = 0; /* … */
for (const campaign of campaigns) {
  const stats = await adService.getCampaignStats(campaign.id);   // ← les chiffres viennent d'ici
  totalImpressions += stats.total_impressions;
  …
}
```

**Ce qui ne va pas.** Le reste du gestionnaire (lignes 790-820) n'utilise de
`campaigns` que `campaigns.length` et `campaign.status`. La collection
`campaign.advertisements` n'est **lue nulle part** : les chiffres proviennent
tous de `adService.getCampaignStats(campaign.id)`, appelé séparément. La
jointure est donc intégralement payée — SQL, réseau, hydratation en objets
Sequelize — puis jetée.

Elle est en plus chargée sans `attributes` : toutes les colonnes de
`advertisements`, y compris les contenus créatifs (textes, URL de médias,
métadonnées de ciblage).

**Effet concret.** Un annonceur avec 40 campagnes de 25 publicités charge 1 000
lignes complètes de `advertisements` pour afficher six compteurs. La réponse,
elle, ne contient aucune de ces données : c'est du travail serveur pur, invisible
côté client, donc jamais remonté par les mesures de taille de réponse.

Deux problèmes s'ajoutent sur la même route :

1. **La boucle `for … await` est séquentielle.** `getCampaignStats` est appelé
   une fois par campagne, l'une après l'autre : 40 campagnes = 40 allers-retours
   en série. (Même famille que R1-04, mais sur une route distincte.)
2. **Aucune pagination**, ce qui est acceptable ici — l'agrégat porte sur toutes
   les campagnes par définition — mais le confirme comme un calcul à faire en
   SQL, pas en JavaScript.

**Correctif.**

- Supprimer l'`include` : une ligne en moins, aucun changement de comportement.
  C'est le correctif le plus rentable de la section — coût nul, risque nul.
- Remplacer la boucle par une seule agrégation :

```sql
SELECT COALESCE(SUM(impressions),0) AS total_impressions,
       COALESCE(SUM(clicks),0)      AS total_clicks,
       COALESCE(SUM(engagements),0) AS total_engagements,
       COALESCE(SUM(spent),0)       AS total_spent
FROM ad_campaigns c JOIN <table de stats> s ON s.campaign_id = c.id
WHERE c.user_id = :uid;
```

  (Je n'ai pas ouvert `adService.getCampaignStats` : la table exacte et le nom
  des colonnes sont à confirmer avant d'écrire cette requête. Le point vérifié
  et certain, c'est que l'`include` est mort.)

- Et compter les statuts en SQL (`COUNT(*) FILTER (WHERE status = 'active')`)
  plutôt qu'avec deux `Array.filter` sur la collection complète.

**Gain :** suppression sèche d'une jointure non bornée sur la table des
publicités ; 41 requêtes ramenées à 1 si l'agrégation est faite en base.

---

## R3-07 — Diffusion des notifications : tous les abonnés chargés, puis une insertion **par abonné, en série**

**Où :** `src/routes/tweetRoutes.js:1603` et `:1609`, dans le bloc
`setImmediate(async () => …)` ouvert ligne 1419 (publication d'un tweet).

```js
const followers = await UserFollow.findAll({
  where: { following_id: userId, status: 'active' },
  attributes: ['follower_id']            // ← aucun `limit`
});
const followerIds = followers.map(f => f.follower_id);
const recipients = await User.findAll({
  where: { id: followerIds },            // ← `IN` de taille = nb d'abonnés
  attributes: ['id', 'id_notif']
});

const seenTokens = new Set();
for (const r of recipients) {
  …
  await Notification.createNotification({ … });   // ← une insertion, en série
}
```

**Ce qui ne va pas — trois amplifications qui se multiplient :**

1. **`findAll` non borné sur `user_follows`** : toute la liste d'abonnés est
   ramenée en mémoire.
2. **Un `IN (…)` de la même taille** sur `users` — c'est le motif de R3-05, mais
   avec ici le nombre d'*abonnés* (potentiellement bien plus grand que le nombre
   d'abonnements) comme facteur.
3. **Une insertion par destinataire, séquentielle** (`await` dans un `for`). La
   déduplication par token (`seenTokens`) est faite **après** le chargement, donc
   elle n'économise rien en lecture.

**Effet concret.** À la publication d'un tweet par un compte suivi par 200 000
personnes : 200 000 lignes lues dans `user_follows`, un littéral `IN` de ~7,6 Mo
envoyé à PostgreSQL, 200 000 lignes lues dans `users`, puis **200 000 `INSERT`
exécutés l'un après l'autre**. À 2 ms l'aller-retour, la diffusion dure plus
d'une heure, en occupant une connexion du pool du début à la fin. Pendant ce
temps, chaque `createNotification` déclenche aussi un envoi push
(`_skip_push: false`).

Le `setImmediate` protège la réponse HTTP — le client reçoit bien son tweet
immédiatement — mais **pas le processus** : le travail reste dans la boucle
d'événements de l'API, sur la même connexion base, en concurrence avec le trafic
des lecteurs. C'est la différence entre « différé » et « mis en file d'attente ».

**Correctif.**

- **Écrire en lot.** Une seule requête remplace les 200 000 :
  `INSERT INTO notifications (recipient_id, sender_id, tweet_id, type, …)
  SELECT follower_id, :author, :tweet, 'system', … FROM user_follows
  WHERE following_id = :author AND status = 'active'` — les destinataires ne
  transitent alors jamais par Node.
- **Traiter par tranches.** Si l'insertion en lot n'est pas possible (hooks du
  modèle), paginer la lecture des abonnés (`limit` 1 000 + `offset`, ou curseur
  sur `created_at`) et faire un `bulkCreate` par tranche.
- **Sortir la diffusion du processus API.** `setImmediate` n'est pas une file
  d'attente : il n'y a ni reprise après redémarrage, ni limitation de débit, ni
  isolation du pool de connexions. Le dépôt dispose déjà d'un
  `realtimeQueueService` (`src/services/realtimeQueueService.js`) — je n'ai pas
  vérifié s'il conviendrait ici, mais c'est la première piste à regarder.
- **Dédupliquer en SQL** (`DISTINCT ON (id_notif)`) plutôt qu'après chargement.

**Relève aussi de R4** (travail long dans la boucle d'événements) : à recouper
quand cette section sera traitée.

**Gain :** de N requêtes à 1 (ou N/1000), et d'une heure d'occupation de
connexion à quelques dizaines de millisecondes, sur le chemin de publication des
comptes les plus suivis — c'est-à-dire exactement quand la plateforme est la
plus chargée.

---

## R3-08 — Quatre routes de liste sans `limit` ni `offset` (croissance non bornée)

Ces routes renvoient une collection dont la taille est décidée par les
utilisateurs, pas par l'API. Aucune ne lit `req.query.limit`. Elles sont plus
petites que R3-03/R3-04 aujourd'hui, mais elles ont la même propriété gênante :
**leur coût augmente tout seul**, sans qu'aucune ligne de code ne change.

### a) `GET /api/users/follow-requests` — `src/routes/userRoutes.js:631`

```js
const requests = await UserFollow.findAll({
  where: { following_id: req.user.id, status: 'pending' },
  include: [{ model: User, as: 'follower', attributes: [ /* 7 colonnes */ ] }],
  order: [['created_at', 'DESC']]
});     // ← ni limit, ni offset
```

Toutes les demandes de suivi en attente, avec le profil complet de chaque
demandeur. Un compte privé un peu visible en accumule des milliers : la réponse
grossit indéfiniment tant que le propriétaire ne les traite pas une par une, et
l'écran devient d'autant plus lent qu'il y a de choses à y faire.
*Correctif :* `limit` (défaut 20, plafond 50) + `offset`, et un compteur séparé
(`COUNT`) pour la pastille.

### b) `loadHighlights()` — `src/routes/storyRoutes.js:164`

```js
const highlights = await StoryHighlight.findAll({
  where: { user_id: String(userId) },
  include: [{ model: StoryHighlightItem, as: 'items', required: false,
              include: [{ model: Story, as: 'story', required: true }] }],
  order: [['position','ASC'], ['created_at','ASC']]
});
```

Toutes les « unes » d'un profil, **et toutes leurs stories**, sur un chemin
d'affichage de profil. Le code n'utilise ensuite que `items[0]?.story?.media_url`
comme couverture et `items.length` comme compteur — les stories complètes ne
servent qu'à la vue détaillée, qui n'est pas celle-ci. *Correctif :* deux
requêtes, une pour les « unes » avec `COUNT` et couverture, une seconde à
l'ouverture d'une « une » précise.

### c) `reactionsFor(messageId)` — `src/routes/messageRoutes.js:1480`

Toutes les réactions d'un message avec l'auteur de chacune, renvoyées à chaque
`POST /:messageId/reactions`. Borné par le nombre de membres d'un groupe, donc
modeste — mais l'écran n'affiche qu'un compteur par emoji. *Correctif :*
renvoyer `GROUP BY emoji` + la réaction de l'appelant.

### d) `GET` messages d'un ticket — `src/routes/supportRoutes.js:260`

Tout le fil d'un ticket de support, sans pagination. Naturellement borné en
pratique ; à surveiller si des tickets à longue vie apparaissent. Le filtrage
`is_internal` y est bien fait **dans la requête** et non à l'affichage — c'est
la bonne pratique, à conserver telle quelle.

**Gain :** faible aujourd'hui, mais ce sont quatre régressions de latence
programmées. Le correctif (a) est le seul qui presse.

---

## R3-09 — `SELECT *` sur `tweets` : 29 colonnes dont 7 JSONB, sur tous les chemins de fil

**Où :** 54 appels `Tweet.findAll(...)` sans `attributes` au premier niveau.
Les plus chauds : `src/routes/tweetRoutes.js:513` (fil principal), `:335`,
`:224`, `src/routes/recommendationRoutes.js:192`, `:241`, `:264`,
`src/routes/searchRoutes.js:89`, `src/routes/aiRecommendationRoutes.js:61`.
Partout, les `include` d'auteur portent bien une liste d'`attributes` — c'est
seulement la table `tweets` elle-même qui est lue en entier.

**Ce qui ne va pas.** `src/models/Tweet.js` déclare **29 colonnes**, dont
**7 JSONB** (`media_urls`, `hashtags`, `mentions`, `urls`, `location`,
`spotify_track`, `metadata`) et **4 TEXT** (`content`, `quote_content`,
`audio_url`, `moderation_reason`). Aucun de ces appels ne restreint les
colonnes : PostgreSQL lit la ligne entière, la détoasté si besoin, l'envoie sur
le réseau, et Sequelize l'hydrate en objet.

Puis, dans le fil (`tweetRoutes.js:542` et `:568`) :

```js
const tweetData = tweet.toJSON();
…
return { ...tweetData, /* + stats */ };     // ← les 29 colonnes partent au client
```

Il n'y a **aucune liste blanche de sortie** : tout ce que la requête a chargé
part dans la réponse HTTP.

**Effet concret.** Sur une page de fil de 100 tweets, chaque ligne transporte
sept documents JSONB dont le client n'utilise, pour la plupart, que
`media_urls`. Les colonnes de **modération** (`moderation_status`,
`moderation_reason`, `recommendation_group`) et le document `metadata` sont
purement internes : ils ne sont affichés nulle part, mais ils sont lus, transmis
et sérialisés à chaque page, pour chaque lecteur. C'est du volume constant payé
sur le chemin le plus chaud de l'API.

> **Note de sécurité.** Le contenu par défaut de la colonne `metadata`
> (`src/models/Tweet.js:498`) fait qu'au moins un champ ne devrait jamais
> quitter le serveur. Le détail est transmis au propriétaire, hors de ce dépôt
> public, et sera repris en section S2.

**Correctif.**

1. **Une liste blanche de sortie**, en un seul endroit — une fonction
   `serializeTweet(tweet)` sur le modèle de `User.getPublicProfile()`, qui
   existe déjà et fait exactement ce travail pour les comptes. Aujourd'hui le
   fil fait `{ ...tweet.toJSON() }`, ce qui est l'inverse : une liste noire
   vide.
2. **Restreindre les `attributes`** des `findAll` de fil aux colonnes réellement
   sérialisées. La liste utile tient en une quinzaine de colonnes ; les
   colonnes de modération et `metadata` n'en font pas partie.

Les deux correctifs sont indépendants : le (1) supprime la fuite de volume vers
le client, le (2) supprime la lecture inutile en base. Le (1) est le plus urgent
et le moins risqué.

**Gain :** réduction directe et proportionnelle de la taille des réponses de
fil, de recherche et de recommandation — les trois routes les plus appelées —
et suppression d'une lecture de colonnes TOAST à chaque ligne.

---

## R3-10 — `purgeExpiredStories()` : toute la table des épinglages chargée pour bâtir un `NOT IN`

**Où :** `src/routes/storyRoutes.js:773`

```js
const pinned = await StoryHighlightItem.findAll({ attributes: ['story_id'] });
//              ↑ aucun `where`, aucun `limit` : la table entière
const pinnedIds = [...new Set(pinned.map(item => String(item.story_id)))];

const where = { expires_at: { [Op.lt]: cutoff } };
if (pinnedIds.length) where.id = { [Op.notIn]: pinnedIds };

const expired = await Story.findAll({ where, paranoid: false, limit: 500 });
```

**Ce qui ne va pas.** La table `story_highlight_items` est lue **intégralement,
sans aucun filtre**, à chaque exécution de la purge. Les identifiants remontent
tous en mémoire Node, puis repartent vers PostgreSQL sous forme d'un littéral
`NOT IN (…)` — le motif de R3-05, appliqué cette fois à une table entière plutôt
qu'à la liste d'un utilisateur.

La lecture des stories expirées, elle, est correctement bornée (`limit: 500`) :
le problème n'est pas là.

**Effet concret.** Les épinglages ne sont jamais purgés — c'est même la règle
explicitée en commentaire (« une story épinglée n'est JAMAIS supprimée »). Cette
table ne fait donc que croître, définitivement. À 200 000 épinglages, chaque
passage de la purge :

- lit 200 000 lignes ;
- construit un tableau JS de 200 000 UUID ;
- envoie ~7,6 Mo de SQL à PostgreSQL ;
- fait évaluer 200 000 comparaisons par ligne candidate, sans qu'aucun index ne
  puisse aider (un `NOT IN` sur littéraux n'est pas transformable en
  anti-jointure).

Et la seule chose que cette masse de données produit est un booléen par story
candidate. À terme, la purge devient plus coûteuse que ce qu'elle purge, puis
finit par ne plus pouvoir s'exécuter du tout (`NOT IN` de plusieurs dizaines de
Mo). C'est une panne différée, pas une lenteur.

**Correctif.** Le prédicat « cette story n'est épinglée nulle part » s'écrit
directement en SQL, en `NOT EXISTS`, et devient alors une anti-jointure indexée :

```js
const expired = await Story.findAll({
  where: {
    expires_at: { [Op.lt]: cutoff },
    id: { [Op.notIn]: sequelize.literal('(SELECT story_id FROM story_highlight_items)') }
  },
  paranoid: false,
  limit: 500
});
```

ou, mieux, en SQL brut avec `NOT EXISTS` :

```sql
SELECT * FROM stories s
WHERE s.expires_at < :cutoff
  AND NOT EXISTS (SELECT 1 FROM story_highlight_items i WHERE i.story_id = s.id)
LIMIT 500;
```

Un index sur `story_highlight_items(story_id)` — à vérifier, je ne l'ai pas
confirmé dans les migrations — rend la vérification immédiate. La requête
devient de taille constante et le coût cesse de dépendre du nombre total
d'épinglages.

**Gain :** de « toute la table + 7,6 Mo de SQL » à une anti-jointure indexée.
C'est le constat le plus important en termes de *durabilité* : c'est le seul de
la section qui finit par casser la fonctionnalité, pas seulement la ralentir.

---

## R3-11 — Trois routes où **le client fixe la taille de page sans plafond**

Le dépôt valide correctement la taille de page **presque** partout : 13 fichiers
de routes déclarent `query('limit').optional().isInt({ min: 1, max: N })`
(`tweetRoutes.js:182`, les 7 routes de `searchRoutes.js`, `userRoutes.js:891`,
`notificationRoutes.js`, `moderationRoutes.js:597`…), et plusieurs services
plafonnent eux-mêmes (`paidContentService.js:544`, `creatorRadarService.js:41`,
`eventPassService.js:649`). Trois routes échappent à cette discipline.

| Route | Fichier | Défaut | Plafond |
|---|---|---|---|
| `GET /api/ads/campaigns` | `adRoutes.js:168`, `limit` utilisé l.193 | 10 | **aucun** |
| `GET /api/ads/advertisements` | `adRoutes.js:232`, `limit` utilisé l.255 | 10 | **aucun** |
| `GET /api/recommendations/progressive` | `progressiveRecommendationRoutes.js:65`, `limit` utilisé l.81 | 50 | **aucun** |

Dans les trois cas, `req.query.limit` est repris tel quel (`parseInt(limit)`) et
passé au `findAll` (ou au moteur) sans `Math.min` ni validation en amont.

**Ce qui ne va pas.** Prises isolément, ces routes ne renverraient « qu' » une
grosse page. Le problème est qu'elles se combinent avec les N+1 déjà relevés en
R1, qui multiplient le nombre de requêtes **par élément de page** :

- `GET /api/ads/campaigns` — R1-03 relève ~900 requêtes pour une page. Ce chiffre
  est établi pour la page par défaut. Un `?limit=1000` multiplie le même schéma
  par cent : la route devient un moyen simple de saturer le pool de connexions,
  sans aucun outil, depuis un compte ordinaire.
- `GET /api/ads/advertisements` — R1-04 relève 4 requêtes par publicité dont 3
  `COUNT`. Même mécanique.
- `GET /api/recommendations/progressive` — le paramètre pilote un découpage en
  mémoire (`slice`, `progressiveRecommendationEngine.js:845-851`) puis
  l'enrichissement par tweet. **Je n'ai pas suivi la chaîne jusqu'au bout** :
  je constate l'absence de plafond, je ne peux pas affirmer le facteur exact.

**Correctif.** Aligner ces trois routes sur ce que fait déjà le reste du dépôt —
une ligne de validation par route :

```js
query('limit').optional().isInt({ min: 1, max: 100 })
  .withMessage('La limite doit être entre 1 et 100'),
```

et, en filet de sécurité pour les cas non validés, appliquer un plafond dur au
moment de l'usage (`Math.min(parseInt(limit) || 10, 100)`), comme le fait
`recommendationRoutes.js:528`.

**Gain :** borne le pire cas de trois routes. Le correctif ne rend rien plus
rapide en usage normal — il empêche le cas dégénéré, et il coûte trois lignes.

---

## Vérifié et trouvé SAIN

Ce qui a été regardé dans cette section et **n'appelle aucun correctif** — noté
pour que la prochaine passe ne le refasse pas :

**Bornage de la taille de page.** La règle est appliquée dans presque tout le
dépôt, souvent avec un message d'erreur explicite :
`tweetRoutes.js:182` (`max: 100`), les 7 routes de `searchRoutes.js`
(`max: 100`, `50`, `20` selon la route), `userRoutes.js:891`,
`tweetRoutes.js:2839` `/:id/likes`, `:2893` `/:id/retweets`, `:2948`
`/:id/replies`, `moderationRoutes.js:597` (`max: 5000`, réservé aux
administrateurs), `recommendationRoutes.js:528` (`Math.min(…, 10)`).
Côté services, le plafond est réappliqué en défense :
`paidContentService.js:544`, `creatorRadarService.js:41` et `:148`,
`eventPassService.js:649`, `messageRoutes.js:1431`.
Seules trois routes y échappent — c'est R3-11.

**`findAll` sans `limit` mais bornés par construction** (une liste d'entrée
elle-même validée, ou un ensemble naturellement petit) :
`tweetRoutes.js:224`, `:335`, `:415`, `:590` (bornés par la sortie du moteur de
pub ou de recommandation), `tweetRoutes.js:3302` (`tweetIds` validé
`isArray({ min: 1, max: 50 })`), `userRoutes.js:406` et `:423` (`userIds`
validé `isArray({ max: 30 })`), `messageRoutes.js:834`, `:1231`, `:1243`,
`:1636` (bornés par les membres du groupe ou la liste d'entrée),
`recommendationRoutes.js:676` et `aiRecommendationRoutes.js:61` (bornés par la
sortie du moteur), `contestRoutes.js:358` et `:458` (bornés par les gagnants),
`walletRoutes.js:15` (borné par le nombre de devises).

**Agrégats déjà faits en base**, et non en JavaScript :
`userRoutes.js:840-862` (`hydrateTweetStats` — cinq agrégats `GROUP BY` en
parallèle sur une liste d'identifiants bornée : c'est exactement la bonne forme,
à prendre comme modèle pour les correctifs R3-06 et R3-07) ;
`moderationController.js:2294`, `:2310`, `:2326` (tendances `GROUP BY DATE(...)`
bornées par la fenêtre demandée).

**Fichiers de routes sans aucun `findAll` non borné :** `userStatsRoutes.js`,
`notificationRoutes.js`, `insightsRoutes.js`, `paidContentRoutes.js`,
`premiumRoutes.js`.

**Listes blanches de sortie déjà en place :** `User.getPublicProfile()`
(`src/models/User.js:31`) énumère explicitement les champs publics, et le
commentaire de `profile_customization_archive` (`:516`) montre que la question
« qu'est-ce qui voyage dans les charges utiles d'auteur ? » a déjà été posée
sérieusement pour les comptes. `userRoutes.js:505` et `:790` renvoient bien un
`user` chargé avec une liste d'`attributes` explicite — aucune colonne de trop.
C'est précisément ce qui manque côté `tweets` (R3-09).

**Filtrage fait dans la requête et non à l'affichage :** `supportRoutes.js:257`
(`if (!staff) where.is_internal = false`) — la bonne pratique, à conserver.

---

## Récapitulatif

| # | Objet | Effet | Correctif |
|---|---|---|---|
| R3-02 | `findExactDirectConversation` | **toute** la table `conversations` par ouverture de discussion | auto-jointure sur les participants |
| R3-07 | diffusion des notifications | N lectures + N `INSERT` **en série** (>1 h à 200 k abonnés) | `INSERT … SELECT`, ou lots + file d'attente |
| R3-10 | `purgeExpiredStories` | `NOT IN` sur une table qui ne fait que croître → panne différée | `NOT EXISTS` |
| R3-05 | liste d'abonnements en `IN` (16 sites) | ~190 Ko de SQL par page de fil, plan jamais réutilisé | sous-requête ; `NOT EXISTS` pour les suggestions |
| R3-09 | `SELECT *` sur `tweets` (54 sites) | 29 colonnes dont 7 JSONB lues **et renvoyées** à chaque page | `serializeTweet()` + `attributes` |
| R3-03 | boîte de réception | aucune pagination : ~300 requêtes, plusieurs Mo | `limit`/`offset` + participants tronqués |
| R3-04 | route des invitations | toute la messagerie chargée pour renvoyer `[]` | prédicat JSONB en SQL |
| R3-01 | réponses du fil de reco | toutes les réponses d'un tweet viral pour en garder 3 | `DISTINCT ON` (ou `limit`) |
| R3-06 | `/api/ads/stats` | une jointure entière chargée puis **jamais lue** | supprimer l'`include` |
| R3-11 | 3 routes sans plafond | amplifient les N+1 de R1-03 et R1-04 par 100 | une ligne de validation par route |
| R3-08 | 4 routes de liste | croissance non bornée, régressions programmées | `limit`/`offset` |

**Les trois premiers gestes, par rentabilité :**

1. **R3-06 puis R3-01** — les deux corrections les moins risquées du rapport :
   supprimer un `include` mort (une ligne retirée, comportement inchangé) et
   borner une requête de réponses (une ligne ajoutée). Quelques minutes, aucun
   changement de schéma, aucun risque de régression.
2. **R3-02** — la seule route dont le coût est proportionnel à la **taille de la
   plateforme** plutôt qu'à celle de l'utilisateur. C'est celle qui se dégradera
   le plus vite, et elle est sur un chemin d'écriture chaud.
3. **R3-07 et R3-10** — les deux qui ne se contentent pas de ralentir : la
   diffusion de notifications monopolise une connexion pendant des heures sur
   les gros comptes, et la purge des stories finira par ne plus pouvoir
   s'exécuter du tout.

**Trois causes racines communes, plutôt que onze défauts indépendants :**

- **Le filtrage fait en JavaScript après un chargement large** plutôt qu'en SQL
  (R3-01, R3-02, R3-04, R3-06). À chaque fois, la base sait faire le travail —
  c'est le code applicatif qui reprend la main trop tôt.
- **La matérialisation d'un ensemble d'identifiants en littéral `IN`/`NOT IN`**
  (R3-05, R3-07, R3-10). Une sous-requête ou un `NOT EXISTS` remplace les deux
  allers-retours par un seul, et rend la taille de requête constante.
- **L'absence de liste blanche de sortie côté `tweets`** (R3-09), alors que
  l'équivalent existe déjà et fonctionne bien côté `users`.

**Recoupement avec les autres sections.** R3-07 est aussi un constat R4
(travail long dans la boucle d'événements sous `setImmediate`) ; R3-02 est aussi
un constat B1 (lecture non bornée à l'intérieur d'une transaction) ; R3-09 ouvre
une piste S2 dont le détail est transmis au propriétaire hors de ce dépôt. Ces
trois recoupements sont à reprendre quand les sections correspondantes seront
traitées.
