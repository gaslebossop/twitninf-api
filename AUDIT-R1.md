# R1 — RAPIDITÉ : requêtes N+1

Section terminée. Constats classés par gain décroissant.

**Contexte chiffré indispensable à la lecture.** Le pool PostgreSQL est
plafonné à **10 connexions** (`src/config/config.js:52`, `DB_POOL_MAX` par
défaut à 10). Toute route qui émet 500 requêtes pour une seule réponse ne les
émet donc pas « en parallèle » : elle les fait défiler par vagues de 10 et
monopolise le pool entier pendant toute la durée de la réponse. C'est ce qui
transforme un N+1 en incident visible sur *toutes* les autres routes en même
temps, pas seulement sur celle qui fautive.

**Fait notable :** le dépôt contient **déjà** les helpers groupés qui
corrigent la quasi-totalité des constats ci-dessous
(`TweetLike.countLikesForTweets`, `TweetLike.likedTweetIdsForUser`,
`TweetRetweet.countRetweetsForTweets`,
`TweetRetweet.retweetedTweetIdsForUser`, `Tweet.countRepliesForTweets`, et
`hydrateTweetStats`). Ils ont visiblement été écrits pour corriger le détail
d'un tweet et le profil — mais **le fil principal, le plus appelé de l'API,
ne les utilise pas**. Les correctifs proposés consistent donc surtout à
appliquer au fil ce qui existe déjà ailleurs.

---

## R1-01 — `GET /api/tweets` (moteur de similarité) : 500 allers-retours **strictement séquentiels**

`src/routes/tweetRoutes.js:358-379`

C'est le chemin nominal du fil pour `sort=recommended|personalized|ultra_recommended|similarity`.
Après avoir récupéré les tweets en une requête groupée (l.335, correct), la
boucle d'enrichissement est un `for (const r of recommendations)` **classique**
avec cinq `await` successifs dans le corps :

```js
const lCount      = await TweetLike.countTweetLikes(sId);
const rtCount     = await TweetRetweet.countTweetRetweets(sId);
const repCount    = await Tweet.count({ where: { parent_tweet_id: sId, ... } });
const iLiked      = await TweetLike.hasUserLikedTweet(userId, sId);
const iRetweeted  = await TweetRetweet.hasUserRetweetedTweet(userId, sId);
```

**Effet concret.** Rien ici n'est parallélisé : ni les tweets entre eux, ni les
cinq métriques d'un même tweet. La limite par défaut de la route est
`limit = 100` (l.196). Une page de fil par défaut = **1 + 500 requêtes
enchaînées bout à bout**. À 2 ms d'aller-retour (même réseau) cela fait
**~1 seconde de latence purement réseau** ; à 5 ms, **2,5 s**. Le temps de
calcul du moteur de reco (annoncé « < 10 ms » en commentaire l.325) est
intégralement noyé par l'enrichissement qui suit.

**Correctif.** Remplacer la boucle par les helpers déjà présents, sur
l'ensemble des `sId` de la page :

```js
const statsIds = recommendations.map(r => String(engagementTargetId(...)));
const [likes, rts, replies, likedByMe, rtByMe] = await Promise.all([
  TweetLike.countLikesForTweets(statsIds),
  TweetRetweet.countRetweetsForTweets(statsIds),
  Tweet.countRepliesForTweets(statsIds),
  TweetLike.likedTweetIdsForUser(userId, statsIds),
  TweetRetweet.retweetedTweetIdsForUser(userId, statsIds),
]);
```

**501 requêtes → 6.** C'est exactement le motif déjà employé en
`src/routes/tweetRoutes.js:834-838` et `:898-902`.

---

## R1-02 — `GET /api/tweets` (chemin classique) : 500 requêtes qui saturent le pool

`src/routes/tweetRoutes.js:541-581`

Même enrichissement, cette fois dans un `Promise.all(tweets.map(async …))`.
Les cinq `await` du corps restent séquentiels *par tweet* (l.558-566), mais
les 100 tweets démarrent ensemble.

**Effet concret.** 500 requêtes déferlent d'un coup sur un pool de 10
connexions : **50 vagues sérialisées**, et surtout **plus une seule connexion
disponible** pour les autres requêtes en vol pendant toute cette durée. Deux
utilisateurs qui rafraîchissent leur fil simultanément mettent 1 000 requêtes
en file d'attente. `pool.acquire` est à 60 s (`config.js:54`) : sous charge,
les autres routes n'échouent pas, elles *attendent*, ce qui se présente comme
une lenteur générale de l'API et non comme une erreur du fil.

**Correctif.** Identique à R1-01, ou plus simplement : réutiliser
`hydrateTweetStats` (`src/routes/userRoutes.js:835`) qui fait déjà exactement
ce travail en 5 requêtes fixes. **501 → 6.**

---

## R1-03 — `GET /api/ads/campaigns` : N+1 **imbriqué**, ~900 requêtes pour une page

`src/routes/adRoutes.js:198-205` → `src/services/adService.js:537-557`
→ `src/models/AdCampaign.js:6-27, 45-90` → `src/models/Advertisement.js:41-44`

La chaîne se déplie ainsi, **par campagne** de la page :

1. `adService.getCampaignStats(campaign.id)` refait un `findByPk` **avec
   `include: advertisements`** (`adService.js:539`) — alors que la ligne vient
   d'être chargée par la requête de liste, et que l'`include` obtenu est
   ensuite **jeté** : `getCampaignStats()` n'utilise pas
   `this.advertisements`.
2. `getCampaignStats()` appelle quatre agrégats (`AdCampaign.js:10-13`).
3. Chacun des quatre appelle `this.getAdvertisements()` — **une requête
   supplémentaire chacun**, soit le même `SELECT` rejoué 4 fois — puis
   **boucle en `for` avec un `await` par publicité** (`AdCampaign.js:49-53`,
   `66-71`, `76-81`, `86+`).
4. `getTotalSpent()` descend encore d'un cran : `Advertisement.getTotalSpent()`
   (`Advertisement.js:41`) fait lui-même un `countImpressions()`.

**Effet concret.** Pour une page de **C** campagnes portant **A** publicités
chacune : `C × (1 + 4 × (1 + A))` requêtes. Pour C=20 et A=10 : **≈ 900
requêtes** pour une seule page d'administration publicitaire — dont ~800
`COUNT(*)` sur `ad_impressions`, la table qui grossit le plus vite du modèle.
Et les quatre agrégats rechargent quatre fois la même liste de publicités.

**Correctif.** Un seul `GROUP BY` remplace tout l'étage :
`SELECT advertisement_id, COUNT(*) FROM ad_impressions WHERE advertisement_id IN (…) GROUP BY 1`
(idem clics et engagements), joint aux publicités des campagnes de la page,
puis agrégation en mémoire. **~900 → 4.** Au minimum, et sans rien
réarchitecturer : supprimer le `findByPk` redondant de `adService.js:539` en
passant l'instance déjà chargée, et faire calculer les quatre agrégats sur
**un seul** `getAdvertisements()`.

## R1-04 — `GET /api/ads/advertisements` : 4 requêtes par publicité, dont 3 `COUNT`

`src/routes/adRoutes.js:260-268` → `src/services/adService.js:562-574`
→ `src/models/Advertisement.js:6-24`

Même forme, un étage de moins : `findByPk` redondant (l.564, la ligne est déjà
en main) + `countImpressions()` + `countClicks()` + `countEngagements()`,
séquentiels (`Advertisement.js:10-12`).

**Effet concret.** Page de 20 publicités = **80 requêtes**, dont 60 `COUNT(*)`
sur les tables d'événements publicitaires. **Correctif :** trois `GROUP BY`
sur la page entière → **3 requêtes**, et suppression du `findByPk`.

---

## R1-05 — `GET /api/search` et `/api/search/tweets` : 5 requêtes **+ une vérification JWT** par tweet

`src/routes/searchRoutes.js:169-206`, `:455-490`, `:614-640`

Le même bloc d'enrichissement est **copié trois fois**. Chaque itération fait
`TweetLike.count` + `TweetRetweet.count` + `Tweet.count` + `hasUserLikedTweet`
+ `hasUserRetweetedTweet`.

S'y ajoute, sur les deux premières copies (l.185-201 et l.470+), un défaut
propre à la recherche : **le jeton JWT est re-décodé et re-vérifié à
l'intérieur de la boucle**, une fois par tweet — `require('jsonwebtoken')`,
`require('../config/config')` et `jwt.verify()` compris. Le `require` est
mis en cache par Node, mais `jwt.verify` effectue une vérification HMAC
complète, **synchrone, sur la boucle d'événements**, à chaque tweet.

**Effet concret.** Pour 50 résultats : **250 requêtes + 50 vérifications HMAC
bloquantes**, pour une information (l'identité de l'appelant) qui est
constante sur toute la requête. Le détail est d'autant plus inutile que la
troisième copie (l.614) prouve qu'un `userId` est disponible en amont sans
re-décodage.

**Correctif.** Sortir la vérification JWT de la boucle — ou mieux, monter
`authenticateToken` sur la route comme partout ailleurs — puis remplacer
l'enrichissement par les helpers groupés. **250 → 5 requêtes, 50 → 1
vérification.** Et factoriser les trois copies en une seule fonction, faute de
quoi le prochain correctif n'en réparera qu'un tiers.

---

## R1-06 — `GET /api/tweets/:id/similar` : 5 requêtes par tweet similaire

`src/routes/tweetRoutes.js:1083-1109`

Deux `Promise.all` de 3 puis 2 métriques, mais **par tweet**, dans un
`.map(async …)`. Les deux groupes sont eux-mêmes séquentiels entre eux
(l.1086 puis l.1092 : l'état d'interaction n'est demandé qu'après les
compteurs, sans raison).

**Effet concret.** 20 tweets similaires = **100 requêtes** au lieu de 5, en
2 vagues. Moins grave que le fil parce que la liste est plus courte, mais
c'est le même correctif au mot près. **Correctif :** helpers groupés,
**100 → 5**.

---

## R1-07 — `GET /api/tweets` (chemin vidéo) : 6 requêtes par vidéo

`src/routes/tweetRoutes.js:248-266`

Mieux écrit que les précédents — deux `Promise.all` — mais toujours par
élément. **Effet concret :** le défaut est ici largement contenu par la limite
par défaut de la route vidéo, `limit = 2` (l.211) : **12 requêtes**. Le risque
est que le client passe `limit=100`, la validation le permet (l.182) :
**600 requêtes**. **Correctif :** helpers groupés ; à défaut, plafonner
explicitement la limite de ce chemin.

---

## R1-08 — Enrichissement par tweet dans les moteurs de recommandation

`src/services/tweetRecommendationService.js:712-726`
`src/services/smartRecommendationEngine.js:1111-1130`

`enrichTweetsWithUserData` et `enrichWithMetadata` refont, chacune, trois
compteurs (+ deux états d'interaction) **par tweet** dans un `.map(async …)`.
Ce sont des services, donc le coût se répète sur chaque route qui les appelle.

**Effet concret.** Multiplie par 5 le nombre de requêtes de toute route
servie par ces moteurs, proportionnellement à la taille de page.
**Correctif :** helpers groupés, appliqués une fois dans le service — le gain
se propage alors à tous les appelants d'un coup.

---

## R1-09 — Remontée du fil de conversation : jusqu'à 50 `SELECT` enchaînés

`src/routes/tweetRoutes.js:867-888`

La chaîne des ancêtres est remontée par un `while` qui fait **un `findOne` par
niveau**, chacun dépendant du précédent (`nextParentId = ancestor.parent_tweet_id`).
Le garde-fou est à 50 niveaux.

**Effet concret.** Ouvrir une réponse profonde dans un long fil = jusqu'à
**50 allers-retours strictement séquentiels** avant même de commencer
l'enrichissement, soit ~100-250 ms de latence réseau pure sur ce seul bloc.
Sur un fil ordinaire de 3-5 niveaux, c'est négligeable — le défaut ne se
manifeste que sur la longue traîne.

**À noter :** contrairement aux constats précédents, ce N+1 est *inhérent* au
parcours de liste chaînée ; il n'est pas dû à un oubli de `include`.
L'enrichissement qui suit (l.897-903) est, lui, correctement groupé et
d'ailleurs commenté comme tel.

**Correctif.** Une CTE récursive PostgreSQL (`WITH RECURSIVE … UNION ALL`
remontant `parent_tweet_id`) ramène toute la chaîne en **une** requête, garde
de profondeur comprise. **50 → 1.**

---

## R1-10 — Mémoïsation anti-doublon inopérante sous `Promise.all` (mineur)

`src/services/smartRecommendationEngine.js:713-721`

La `Map` locale `shadowbanChecks` est destinée à ne vérifier qu'une fois le
shadowban d'un auteur qui publie plusieurs tweets de la page. Elle ne peut pas
fonctionner : sous `Promise.all(tweets.map(async …))`, **tous** les rappels
lisent la `Map` avant que le premier `await` n'ait écrit dedans. La première
vague de lectures est donc systématiquement en échec de cache.

**Effet concret — et pourquoi c'est mineur.** Le dégât réel est limité par un
*second* cache, celui-là à TTL et porté par le service
(`this.shadowbanCache`, `smartRecommendationEngine.js:2408-2413`), qui absorbe
les appels répétés. Le surcoût se réduit donc au premier remplissage par
utilisateur et par fenêtre de TTL, pas à chaque page. La `Map` locale est,
elle, purement inutile.

**Correctif.** Dédupliquer **avant** la boucle :
`const uniqueAuthors = [...new Set(tweets.map(t => t.author_id))]`, résoudre
les statuts en un `Promise.all` sur cette liste, puis consulter le résultat
de façon synchrone dans le `.map`.

---

# Vérifié et trouvé SAIN

Ces chemins ont été lus en cherchant précisément le N+1 et n'en présentent
pas. Ils constituent le modèle à recopier ailleurs.

- **`GET /api/users/:id/tweets`** (`src/routes/userRoutes.js:887-1071`) —
  le profil, deuxième route la plus chaude. Les trois onglets (tweets,
  retweets, j'aime) passent par `hydrateTweetStats`
  (`src/routes/userRoutes.js:835-869`) : **5 requêtes fixes quelle que soit la
  taille de la page**, via `GROUP BY`. C'est la référence.

- **`filterVisibleTweets`** (`src/utils/privateAccountVisibility.js:83-122`) —
  résout la visibilité des comptes privés d'une page entière en 1 requête, et
  **sort avant même de charger le graphe de suivi** quand la page ne contient
  aucun compte privé (l.103-104), c'est-à-dire dans le cas le plus fréquent.

- **`paidContentService.maskTweets`**
  (`src/services/paidContentService.js:465-501`) — traverse récursivement les
  tweets, leurs originaux et leurs parents (`collectTweetNodes`, l.433-455),
  dédoublonne par identité d'objet, et ne fait ensuite que **2 requêtes** pour
  toute la liste. Passe sur chaque réponse de fil sans coût proportionnel.

- **Détail d'un tweet, réponses et ancêtres**
  (`src/routes/tweetRoutes.js:834-838` et `:898-902`) — usage exemplaire des
  helpers groupés, 5 requêtes pour tout le bloc.

- **`GET /api/notifications`** (`src/routes/notificationRoutes.js:65`) — la
  liste, le compteur de non-lues et le total partent dans un unique
  `Promise.all`, sans hydratation par élément.

- **`GET /api/tweets` — récupération des tweets elle-même**
  (`src/routes/tweetRoutes.js:335-350` et `:513-535`) — les `include` de
  l'auteur et du tweet original sont bien posés : **aucun** N+1 sur les
  auteurs, y compris l'auteur du tweet cité. Le défaut du fil est
  exclusivement dans l'enrichissement statistique qui suit.

- **Injection publicitaire dans le fil**
  (`src/routes/tweetRoutes.js:415-419` et `:590-594`) — les auteurs des
  publicités sont chargés en une requête sur des identifiants dédoublonnés.

---

## Récapitulatif

| # | Route / service | Requêtes actuelles (page type) | Après correctif |
|---|---|---|---|
| R1-01 | `GET /api/tweets` (similarité) | ~501, **séquentielles** | 6 |
| R1-02 | `GET /api/tweets` (classique) | ~501, pool saturé | 6 |
| R1-03 | `GET /api/ads/campaigns` | ~900 | 4 |
| R1-04 | `GET /api/ads/advertisements` | ~80 | 3 |
| R1-05 | `GET /api/search*` (×3) | ~250 + 50 HMAC | 5 + 1 |
| R1-06 | `GET /api/tweets/:id/similar` | ~100 | 5 |
| R1-07 | `GET /api/tweets` (vidéo) | 12, jusqu'à 600 | 6 |
| R1-08 | moteurs de reco (2 services) | ×5 par tweet | 5 par page |
| R1-09 | ancêtres d'un fil | jusqu'à 50 séquentielles | 1 |
| R1-10 | dédoublonnage shadowban | cache inopérant | — |

**Le plus rentable, et de loin :** R1-01 et R1-02. Ils portent sur la même
route — celle du fil, la plus appelée de l'API — le correctif est le même pour
les deux, et le code du correctif existe déjà dans le dépôt.
