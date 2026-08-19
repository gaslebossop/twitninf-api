# R2 — RAPIDITÉ : index et requêtes lentes

Section terminée. Constats classés par gain décroissant.

**Deux faits de contexte gouvernent toute la section.**

1. **Le schéma est produit par `sequelize.sync({ force: false, alter: false })`**
   (`src/models/index.js:1793`), pas par des migrations : le dossier
   `src/migrations/` ne couvre qu'une trentaine de changements ponctuels. Avec
   `alter: false`, `sync` **crée** les tables absentes mais ne touche **jamais**
   à une table existante. Conséquence directe et lourde : **tout index ajouté à
   un modèle après la première création de sa table n'existe pas en
   production.** La liste `indexes:` d'un modèle décrit donc l'intention, pas
   nécessairement l'état réel de la base. Toute recommandation ci-dessous doit
   être appliquée par un `CREATE INDEX CONCURRENTLY` explicite, pas en éditant
   le modèle.

2. **Le pool est à 10 connexions** (`src/config/config.js:52`). Une requête qui
   passe de 5 ms à 800 ms n'occupe pas seulement son appelant : elle retient
   1/10ᵉ de la capacité de l'API pendant tout ce temps.

---

## R2-01 — `user_id::text = :userId` : le transtypage annule l'index, sur 68 requêtes

`src/routes/userStatsRoutes.js` (56 occurrences), et 12 autres réparties dans
`communityModerationService.js`, `creatorRadarService.js`,
`predictiveAnalyticsService.js`, `raidBotService.js`, `trendRadarService.js`,
`customTweetGenerationService.js`, `progressiveRecommendationEngine.js`,
`scheduledTweetService.js`, `adRoutes.js`.

Exemples : `userStatsRoutes.js:90`, `:113`, `:250`, `:289`, `:311`, `:331`,
`:351`, `:371`, `:392`, `:412`, `:544`, `:639`, `:654`.

```sql
WHERE t.user_id::text = :userId          -- userStatsRoutes.js:544
JOIN tweets t ON t.id::text = ubd.target_id::text   -- userStatsRoutes.js:665
WHERE (uf.following_id::text = :userId OR uf.follower_id::text = :userId)
```

`Tweet.user_id`, `Tweet.id`, `UserFollow.follower_id` et `following_id` sont
déclarés `DataTypes.UUID` (`src/models/Tweet.js:251, 261, 271`). La conversion
**UUID → text n'est pas binairement compatible** en PostgreSQL : c'est un
appel de fonction réel, pas un simple réétiquetage. Le planificateur ne peut
donc **pas** utiliser l'index btree sur la colonne — il doit calculer
`user_id::text` pour chaque ligne de la table avant de comparer.

**Effet concret.** `tweets_user_id` et le composite `(user_id, created_at)`
(`src/models/Tweet.js:596-598`) sont déclarés mais **inutilisables sur toutes
ces requêtes**. Chacune dégénère en **parcours séquentiel complet de la table
`tweets`**, quel que soit le nombre de tweets de l'utilisateur ciblé. Sur une
table d'un million de lignes, une statistique de profil qui devrait lire ~200
lignes en 2 ms en lit 1 000 000 — de l'ordre de plusieurs centaines de ms, et
en I/O disque, pas en cache. Toute la page de statistiques créateur enchaîne
une dizaine de ces requêtes.

**Correctif.** Transtyper le **paramètre**, jamais la colonne :

```sql
WHERE t.user_id = :userId::uuid
```

L'index redevient immédiatement utilisable, sans aucun changement de schéma.
C'est le correctif au meilleur rapport gain/risque de toute la section.

**Nuance à ne pas confondre.** Les casts sur
`user_behavior_data.target_id` (`userStatsRoutes.js:111`, `:392`) portent sur
une colonne `DataTypes.STRING` (`src/models/UserBehaviorData.js:79`) :
varchar → text **est** binairement compatible, l'index
`(target_id, target_type)` reste utilisable. Ceux-là ne sont pas à corriger en
priorité. En revanche `t.id::text = ubd.target_id` (`userStatsRoutes.js:288`,
`:370`, `:665`) casse bien le côté `tweets` de la jointure.

---

## R2-02 — `GET /api/search/tweets` : un `COUNT(*)` de toute la table, **et un total faux**

`src/routes/searchRoutes.js:515` et `:644`

```js
const tweets = await Tweet.searchTweets(query, {...});   // filtre sur le terme
...
const totalCount = await Tweet.count({ where: whereClause });  // ne le contient pas
```

Le `whereClause` construit dans la route (`searchRoutes.js:418-442`) contient
`is_private: false`, `moderation_status: 'approved'` et les filtres
optionnels — **mais pas le terme recherché**, qui n'est appliqué qu'à
l'intérieur de `Tweet.searchTweets` (`src/models/Tweet.js:73-82`). Les deux
prédicats divergent aussi sur `deleted_at`, présent dans `searchTweets` et
absent de la route.

**Double effet, tous deux graves.**

- *Performance* : le `COUNT` porte sur **tous les tweets publics approuvés de
  la base**. C'est un parcours complet, sans `LIMIT` exploitable, exécuté à
  **chaque frappe** si le client déclenche la recherche à la saisie. C'est de
  loin la requête la plus coûteuse de la route — plus coûteuse que la
  recherche elle-même.
- *Correction* : le `total` renvoyé n'a aucun rapport avec le nombre de
  résultats. Une recherche qui rend 3 tweets annonce un total de plusieurs
  millions, et `hasMore` (calculé depuis ce total) reste vrai indéfiniment :
  **le défilement infini du client ne se termine jamais**, il redemande des
  pages vides jusqu'à épuisement.

**Correctif.** Supprimer purement et simplement ce `COUNT`. Le motif
« demander `limit + 1` lignes et déduire `hasMore` de la présence de la
(limit+1)ᵉ » donne la bonne réponse pour **zéro** requête supplémentaire, et
c'est la seule information dont un défilement infini a besoin. Si un total
exact est réellement exigé par l'interface, il doit au minimum réutiliser le
prédicat de `searchTweets`.

---

## R2-03 — `GET /api/tweets` : un `COUNT(*)` de toute la table à chaque page de fil

`src/routes/tweetRoutes.js:623-625`

```js
const totalCount = await Tweet.count({ where: whereClause });
```

Ici le prédicat est bien le même que celui des résultats (le commentaire l.622
y insiste), donc le total est juste. Le problème est le coût : le prédicat est
`is_private = false AND is_data_test = false AND deleted_at IS NULL AND
moderation_status = 'approved'` + la clause `OR` sur les types — c'est-à-dire
**la quasi-totalité de la table**. Un `COUNT` ne peut pas s'arrêter à 100
lignes : il les compte toutes.

**Effet concret.** La route de fil, la plus appelée de l'API, ajoute à chaque
appel un parcours complet de `tweets`. Ce coût est **constant par requête et
croissant avec la table** : contrairement au N+1 de R1, il ne diminue pas si
l'on réduit la taille de page. À un million de tweets, on est dans l'ordre de
100–300 ms de CPU base par appel de fil, uniquement pour afficher un nombre
que le client n'utilise que pour un `hasMore`.

**Correctif.** Même que R2-02 : `limit + 1`. Si le total doit rester affiché,
un compteur approché (`reltuples` de `pg_class`, ou un compteur matérialisé
rafraîchi périodiquement) est la réponse standard — un fil n'a pas besoin d'un
total exact à la ligne près.

---

## R2-04 — Aucun index ne sert le prédicat du fil ; le tri se fait sans

`src/routes/tweetRoutes.js:474-535`, index déclarés en `src/models/Tweet.js:542-605`

La requête de fil est :

```sql
WHERE is_private = false AND is_data_test = false AND deleted_at IS NULL
  AND moderation_status = 'approved'
  AND ( (parent_tweet_id IS NULL AND is_retweet = false AND is_quote = false)
        OR is_retweet = true OR is_quote = true )
ORDER BY created_at DESC LIMIT 100 OFFSET n
```

Les index déclarés sur `tweets` sont **tous mono-colonne** sauf trois
composites — `(user_id, created_at)`, `(parent_tweet_id, created_at)`,
`(tweet_type, created_at)` — dont **aucun** ne correspond à ce prédicat.
Aucun index ne couvre `(moderation_status, is_private, deleted_at,
created_at)`.

**Effet concret.** Le planificateur n'a que deux mauvais choix : parcourir
l'index `created_at` à rebours en filtrant ligne à ligne (il doit visiter
d'autant plus de lignes que la proportion de tweets rejetés/supprimés est
élevée), ou combiner par bitmap plusieurs index à très faible sélectivité, ce
qui est presque toujours plus cher qu'un parcours séquentiel. Le `OR` de la
clause de type interdit en plus toute correspondance d'index unique. Le coût
croît linéairement avec `OFFSET`.

**Correctif.** Un **index partiel** calqué exactement sur le prédicat, qui rend
la pagination du fil quasi constante :

```sql
CREATE INDEX CONCURRENTLY tweets_feed_idx
  ON tweets (created_at DESC)
  WHERE deleted_at IS NULL
    AND is_private = false
    AND is_data_test = false
    AND moderation_status = 'approved';
```

L'index ne contient alors que les lignes réellement servies, et le `ORDER BY
… LIMIT` se résout en lisant les 100 premières entrées de l'index. Gain
attendu : d'un parcours proportionnel à la table à une lecture proportionnelle
à la page.

---

## R2-05 — `sort=popular` : tri complet sans index sur `view_count`

`src/routes/tweetRoutes.js:506-507`

```js
orderClause = [['view_count', 'DESC'], ['created_at', 'DESC']];
```

`view_count` (`src/models/Tweet.js:420`) **n'apparaît dans aucune entrée de la
liste `indexes:`**.

**Effet concret.** PostgreSQL doit matérialiser puis trier **l'intégralité**
de l'ensemble filtré avant de rendre les 100 premières lignes. C'est un tri
externe (sur disque) dès que l'ensemble dépasse `work_mem`. Sur une table d'un
million de tweets, c'est de l'ordre de la seconde, et cela consomme du disque
temporaire à chaque appel.

**Correctif.** `CREATE INDEX CONCURRENTLY ON tweets (view_count DESC, created_at DESC)`,
idéalement partiel sur le même prédicat que R2-04 pour que l'index serve le
filtre *et* le tri en une passe.

---

## R2-06 — Recherche texte : `ILIKE '%…%'` sur `tweets.content` et `users.username`

`src/models/Tweet.js:76`, `:97`, `:105` — `src/models/User.js:75-76`

```js
{ content:   { [Op.iLike]: `%${query}%` } }   // Tweet.searchTweets
{ username:  { [Op.iLike]: `%${query}%` } }   // User.searchUsers
{ full_name: { [Op.iLike]: `%${query}%` } }
```

Un motif commençant par `%` est **le cas d'école qu'aucun index btree ne peut
servir** : il n'y a pas de préfixe à chercher dans l'arbre. L'index unique sur
`users.username` (`src/models/User.js:606-609`) est parfaitement inutile ici.

**Effet concret.** Chaque recherche — de tweet comme d'utilisateur — impose un
**parcours séquentiel complet** de la table concernée, avec une comparaison
insensible à la casse sur chaque ligne. Sur `tweets`, c'est la table la plus
volumineuse du modèle. Et comme la recherche est typiquement déclenchée à la
saisie, on parle de plusieurs parcours complets **par seconde et par
utilisateur qui tape**.

Les trois branches de `searchTweets` (l.94-107) sont d'ailleurs **identiques**
au commentaire près : le cas `#hashtag` et le cas `@mention` réécrivent
`Op.or` avec exactement la même condition `content ILIKE`. Le traitement
spécialisé annoncé n'existe pas, alors même que des colonnes `hashtags` et
`mentions` dédiées et indexées existent.

**Correctif.** Index trigramme, qui est précisément fait pour `LIKE '%…%'` :

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY tweets_content_trgm ON tweets USING gin (content gin_trgm_ops);
CREATE INDEX CONCURRENTLY users_username_trgm ON users USING gin (username gin_trgm_ops);
CREATE INDEX CONCURRENTLY users_fullname_trgm ON users USING gin (full_name gin_trgm_ops);
```

Pour la recherche de tweets, une colonne `tsvector` + index GIN + `to_tsquery`
est encore nettement supérieure si la recherche par mots suffit. Et faire
réellement passer la branche `#…` par la colonne `hashtags` (voir R2-09).

---

## R2-07 — Statistiques créateur : produit cartésien de trois jointures

`src/routes/userStatsRoutes.js:511-552`

```sql
FROM tweets t
LEFT JOIN tweet_likes    tl    ON t.id = tl.tweet_id
LEFT JOIN tweet_retweets tr    ON t.id = tr.tweet_id
LEFT JOIN tweets         reply ON t.id = reply.parent_tweet_id
...
COUNT(DISTINCT tl.id), COUNT(DISTINCT tr.id), COUNT(DISTINCT reply.id)
```

Trois jointures « un vers plusieurs » sur la **même** table de gauche se
multiplient entre elles avant l'agrégation. Le `COUNT(DISTINCT …)` corrige le
résultat, mais **après** que les lignes ont été produites.

**Effet concret.** Un tweet avec 100 likes, 20 retweets et 50 réponses génère
`100 × 20 × 50 = 100 000` lignes intermédiaires **à lui seul**, qu'il faut
ensuite trier pour dédupliquer. Sur les 100 tweets d'un créateur actif, on
atteint facilement plusieurs millions de lignes intermédiaires pour rendre 20
résultats. C'est très probablement la requête la plus chère de toute l'API, et
elle est aggravée par R2-01 (`t.user_id::text`, l.544) qui lui interdit en
plus de restreindre par index.

S'y ajoute la sous-requête `sh` (l.537-542) qui agrège **toute** la table
`user_behavior_data` — sans le moindre filtre sur l'utilisateur — avant de la
joindre.

**Correctif.** Agréger séparément puis joindre les agrégats, jamais les
lignes :

```sql
LEFT JOIN (SELECT tweet_id, COUNT(*) c FROM tweet_likes    GROUP BY 1) tl ON …
LEFT JOIN (SELECT tweet_id, COUNT(*) c FROM tweet_retweets GROUP BY 1) tr ON …
```

— ou, mieux, des sous-requêtes latérales restreintes aux seuls tweets de
l'utilisateur. Et filtrer `sh` sur ces mêmes tweets. On passe de millions de
lignes intermédiaires à quelques centaines.

---

## R2-08 — Index déclarés qui ne servent à rien, sur les tables les plus écrites

Le prompt demandait explicitement ce point. Trois familles, toutes sur
`tweets`, `users`, `tweet_likes` — c'est-à-dire là où chaque index inutile
coûte à **chaque insertion**.

**(a) Six index sur `data_test_batch_id`, créés en production par un script de
banc d'essai.**
`scripts/capacityDataLifecycle.js:145-150` exécute
`CREATE INDEX IF NOT EXISTS` sur `users`, `tweets`, `tweet_likes`,
`tweet_retweets`, `user_follows` et `user_behavior_data`. Cette colonne est
`NULL` pour la totalité des lignes réelles et n'est lue que par les scripts de
charge (`capacityLoadBenchmark.js:506`, `clusterLoadBenchmark.js:197`). Ce sont
**six index maintenus en permanence sur les six tables les plus écrites, pour
un usage strictement hors production.**
*Correctif :* `DROP INDEX CONCURRENTLY` des six, ou les rendre partiels
(`WHERE data_test_batch_id IS NOT NULL`), ce qui les réduit à quelques pages.

**(b) Cinq index mono-colonne sur des booléens de `tweets`.**
`is_retweet`, `is_quote`, `is_pinned`, `is_private`, `deleted_at`
(`src/models/Tweet.js:558-578`). Une colonne à deux valeurs n'est pas
sélective : le planificateur préfère presque toujours le parcours séquentiel.
Ils ne servent donc jamais seuls, tout en étant mis à jour à chaque écriture.
*Correctif :* les remplacer par les index **partiels et composites** de R2-04,
qui encodent la même information dans la clause `WHERE` de l'index au lieu
d'une colonne.

**(c) Cinq index GIN morts.**
`Tweet.mentions`, `Tweet.media_urls`, `Tweet.urls`
(`src/models/Tweet.js:584-595`), `User.stats`, `User.preferences`
(`src/models/User.js:636-644`). Une recherche exhaustive dans `src/routes/` et
`src/services/` ne trouve **aucune** requête utilisant un opérateur de
contenance JSONB (`@>`, `?`, `?|`, `?&`) sur l'une de ces cinq colonnes. Un
index GIN sur JSONB est parmi les plus coûteux à maintenir en écriture.
*Correctif :* les supprimer. Seul `hashtags` mérite un GIN — voir R2-09.

---

## R2-09 — Le seul index GIN utile n'est pas servi par l'opérateur employé

`src/models/Tweet.js:328-330` (colonne) et `:580-583` (index) ;
usages en `src/routes/searchRoutes.js:436`, `:595`, `:694`, `:91` et
`src/services/recommendationEngine.js:2628`

```js
whereClause.hashtags = { [Op.overlap]: [hashtag] };
```

`hashtags` est déclaré `DataTypes.JSONB`, indexé en GIN. Or `Op.overlap`
produit l'opérateur `&&`, et **`&&` n'est pas un opérateur de la classe GIN
par défaut pour `jsonb` (`jsonb_ops`)**, qui ne couvre que `@>`, `?`, `?|` et
`?&`. L'index ne peut donc pas servir cette requête.

**Incertitude assumée, et elle mérite d'être levée en premier.** `&&` n'est pas
défini du tout entre `jsonb` et un tableau littéral en PostgreSQL : la requête
devrait échouer sur `operator does not exist`. Deux lectures possibles, que je
n'ai pas pu départager sans exécuter contre la base :

- soit la colonne physique est en réalité `text[]` (créée avant que le modèle
  ne passe en JSONB — `sync({alter:false})` ne l'aurait jamais convertie), et
  alors `&&` fonctionne et l'index GIN est **utilisé** : tout va bien, mais le
  modèle ment sur le type réel ;
- soit la colonne est bien `jsonb`, et **la recherche par hashtag est
  cassée en production**, chaque appel remontant une erreur SQL.

**À faire, dans cet ordre :** `\d tweets` sur la colonne `hashtags` pour
trancher. Si elle est `jsonb`, remplacer `Op.overlap` par une contenance
(`hashtags @> '["#tag"]'::jsonb`), qui est servie par l'index GIN existant.

---

## R2-10 — `is_data_test` : colonne du prédicat le plus chaud, absente du modèle

`src/models/Tweet.js` — la colonne n'y est **pas déclarée** ; elle est
pourtant utilisée dans 51 clauses `where` de `src/routes/` et `src/services/`,
dont celle du fil (`src/routes/tweetRoutes.js:475`).

La seule chose qui crée cette colonne sur `tweets` est
`scripts/capacityDataLifecycle.js:143` :
`ALTER TABLE … ADD COLUMN IF NOT EXISTS is_data_test BOOLEAN NOT NULL DEFAULT FALSE`
— un script de banc d'essai. Aucune migration, aucune déclaration de modèle.

**Effet concret, en deux temps.**

- *Robustesse* : la route de fil dépend d'une colonne créée par un outil de
  test de charge. Sur tout environnement où ce script n'a jamais tourné —
  une base neuve, un environnement de recette, une restauration —
  `GET /api/tweets` échoue avec `column "is_data_test" does not exist`. Le
  chemin le plus critique de l'API repose sur un effet de bord.
- *Performance* : parce que la colonne est inconnue du modèle, `sequelize.sync`
  ne pourra **jamais** l'indexer, et elle est absente de toute liste
  `indexes:`. Elle siège pourtant dans le prédicat du fil.

**Correctif.** Déclarer la colonne dans `src/models/Tweet.js` **et** l'ajouter
par une vraie migration, puis l'inclure dans l'index partiel de R2-04 — ce qui
la rend gratuite, la clause partielle absorbant le filtre.

---

## R2-11 — `getPopularUsers` : `ORDER BY stats DESC` sur une colonne JSONB

`src/models/User.js:88-98`

```js
order: [['stats', 'DESC']]
```

`stats` est une colonne JSONB (`src/models/User.js:448`). PostgreSQL sait
ordonner du `jsonb`, mais selon un ordre **structurel** (type, puis nombre de
clés, puis comparaison clé à clé) qui n'a aucun rapport avec la popularité.
Aucun index ne peut servir ce tri : GIN ne supporte pas l'ordonnancement.

**Effet concret.** Parcours complet de `users` + tri complet, à chaque appel,
pour un résultat dont le classement est arbitraire. Le défaut est donc
**double** : lent *et* faux.

**Correctif.** Trier sur une expression extraite et l'indexer :
`ORDER BY (stats->>'followers')::int DESC` avec
`CREATE INDEX CONCURRENTLY ON users (((stats->>'followers')::int) DESC)`.
Une colonne dénormalisée `followers_count` entretenue par déclencheur serait
plus robuste encore.

---

## R2-12 — Onglet « Médias » du profil : filtre non indexable

`src/routes/userRoutes.js:1018-1026`

```js
sequelize.where(sequelize.fn('jsonb_array_length', sequelize.col('media_urls')), { [Op.gt]: 0 })
```

Un index GIN sur `media_urls` (déclaré, cf. R2-08c) **ne sert pas**
`jsonb_array_length` : GIN indexe le contenu, pas la cardinalité. La fonction
est évaluée sur chaque ligne candidate.

**Effet concret.** Contenu par le filtre `user_id` qui, lui, est indexé
(`(user_id, created_at)`) et s'applique d'abord : le parcours reste borné aux
tweets de l'utilisateur affiché. C'est donc un défaut **mineur**, qui ne
devient sensible que sur un compte à très gros volume.

**Correctif.** Un index partiel exprimé sur la même fonction :
`CREATE INDEX CONCURRENTLY ON tweets (user_id, created_at DESC) WHERE jsonb_array_length(media_urls) > 0`.

---

# Vérifié et trouvé SAIN

- **`UserFollow`** (`src/models/UserFollow.js:317-341`) — **le modèle le mieux
  indexé du dépôt.** Les composites `(follower_id, status)` et
  `(following_id, status)` correspondent exactement aux requêtes réelles :
  `countFollowers` (`:107-111`) et `countFollowing` filtrent sur
  `following_id` + `status = 'active'` et sont servis intégralement par
  l'index. C'est le modèle à imiter.

- **`Notification`** (`src/models/Notification.js:375-407`) — les trois
  composites `(recipient_id, is_read)`, `(recipient_id, created_at)`,
  `(recipient_id, type)` couvrent les trois usages effectifs de la route
  (`src/routes/notificationRoutes.js:65`). Rien à ajouter.

- **`Message`** (`src/models/Message.js:55-59`) — l'index
  `(conversation_id, created_at)` est exactement ce qu'il faut pour paginer une
  conversation, et la liste d'index est **courte** : pas d'index décoratif.

- **`tweet_likes_created_at_tweet_id`** (`src/models/TweetLike.js:207-212`) —
  index composite créé pour un besoin précis (agrégation « plus liké de la
  veille »), documenté par un commentaire qui nomme la requête servie. C'est la
  bonne pratique : un index justifié par son appelant.

- **`Tweet.countRepliesForTweets`** et les helpers groupés
  (`src/models/Tweet.js:214-225`, `TweetLike.js:81-96`) — le `GROUP BY` porte
  sur `parent_tweet_id` / `tweet_id`, tous deux indexés. Les requêtes qui
  corrigent le N+1 de R1 sont elles-mêmes correctement servies : appliquer R1
  n'introduira pas de nouveau problème d'index.

- **Aucun `ORDER BY RANDOM()` dans tout le dépôt.** Les deux seules
  occurrences du terme sont des commentaires
  (`src/services/contestService.js:14`, `src/models/Contest.js:33`) expliquant
  qu'il a été délibérément évité au profit d'un tirage reproductible. Le piège
  classique a été vu et esquivé.

- **Routage vers la réplique de lecture**
  (`src/database/requestReadRouting.js`, `src/models/index.js`, documenté en
  `SCALING.md:460-480`) — les `SELECT` hors GET/HEAD sont forcés sur le nœud
  primaire via un `AsyncLocalStorage`, ce qui évite la classe de bug « je crée
  puis je relis sur un standby en retard ». Correctement pensé, correctement
  documenté, et le gain a été mesuré (`+41 584` lignes lues sur le standby pour
  40 GET). Rien à redire.

- **`dialectOptions.statement_timeout = 60000`** (`src/config/config.js:64`) —
  un garde-fou existe : aucune requête ne peut retenir une connexion
  indéfiniment. C'est ce qui empêche les constats ci-dessus de dégénérer en
  panne complète.

---

## Récapitulatif

| # | Objet | Effet | Correctif |
|---|---|---|---|
| R2-01 | `uuid::text` × 68 | index annulés, parcours complets | transtyper le **paramètre** |
| R2-02 | `COUNT` de recherche | table entière **+ total faux** | supprimer, `limit + 1` |
| R2-03 | `COUNT` du fil | table entière à chaque page | `limit + 1` |
| R2-04 | prédicat du fil | aucun index adapté | index **partiel** `created_at DESC` |
| R2-05 | `sort=popular` | tri complet, souvent sur disque | index `(view_count DESC, …)` |
| R2-06 | `ILIKE '%…%'` | parcours complet par frappe | `pg_trgm` / `tsvector` |
| R2-07 | stats créateur | produit cartésien, ~10⁶ lignes | agréger avant de joindre |
| R2-08 | 16 index inutiles | écritures ralenties en permanence | supprimer / rendre partiels |
| R2-09 | GIN `hashtags` | opérateur inadapté, ou route cassée | **vérifier le type réel** |
| R2-10 | `is_data_test` | hors modèle, non indexable, fragile | déclarer + migration |
| R2-11 | `ORDER BY stats` | lent **et** classement arbitraire | trier sur l'expression, l'indexer |
| R2-12 | onglet médias | fonction non indexable | index partiel |

**Les trois premiers gestes, par rentabilité :**
1. **R2-01** — remplacer `colonne::text = :param` par `colonne = :param::uuid`.
   Aucun changement de schéma, aucun risque, et cela rend leur utilité à des
   index déjà présents sur les requêtes de statistiques.
2. **R2-02 / R2-03** — retirer les deux `COUNT(*)` des chemins d'affichage.
   Deux suppressions de lignes, et R2-02 corrige au passage un défilement
   infini qui ne se termine jamais.
3. **R2-04** — créer l'index partiel du fil. Un seul `CREATE INDEX
   CONCURRENTLY`, sur la route la plus appelée de l'API.

**Point d'attention transverse :** à cause de `sync({ alter: false })`
(constat de contexte n° 1), aucun de ces index ne doit être ajouté en éditant
un modèle — cela n'aurait strictement aucun effet sur la base existante.
Chacun doit faire l'objet d'un `CREATE INDEX CONCURRENTLY` dans une migration
réelle. Cela vaut aussi pour vérifier l'existant : **il faut confronter la
liste `indexes:` des modèles à un `\di` sur la base de production** avant de
conclure quoi que ce soit sur ce qui est réellement en place.
