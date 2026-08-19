# R4 — Travail bloquant (boucle d'événements)

> Section 4 de l'audit `twitninf-api`. Priorité **RAPIDITÉ**.
>
> On cherche ici ce qui **immobilise le processus** : traitement d'image,
> cryptographie lourde, `readFileSync`, boucle sur un gros tableau, appel réseau
> sans délai d'attente. Et, symétriquement, ce qui devrait être fait en tâche de
> fond et ne l'est pas.
>
> Node.js n'a qu'un seul fil d'exécution pour le JavaScript : tout ce qui bloque
> ici ne ralentit pas *une* requête, il ralentit **toutes celles en cours**.
>
> Chaque constat est vérifié dans le code avant d'être écrit. Quand une
> incertitude subsiste, elle est dite explicitement. Les constats sont classés
> par gain décroissant.

---

## R4-01 — Sept appels réseau **sans délai d'attente**, dont un sur le chemin de connexion

Un appel HTTP sortant sans `timeout` n'échoue pas : il **attend**. Si le serveur
distant accepte la connexion TCP puis ne répond jamais (panne partielle,
équilibreur saturé, table de suivi de connexions pleine), la promesse ne se
résout ni ne se rejette. La requête entrante qui l'attend reste ouverte, avec
tout ce qu'elle immobilise : une connexion HTTP, un contexte, et — quand l'appel
est fait à l'intérieur d'une transaction — une connexion PostgreSQL.

Ni `axios` ni le `fetch` global de Node n'appliquent de délai par défaut :
`axios` documente `timeout: 0` (aucun) comme valeur par défaut, et le `fetch`
d'undici n'a pas de délai de requête global. **Le délai doit être écrit
explicitement.** Le dépôt le fait à sept endroits, et l'oublie à sept autres.

### Sans délai d'attente

| Fichier:ligne | Appel | Contexte |
|---|---|---|
| `src/services/gAuthService.js:208` | `POST {ISSUER}/oauth/token` | **chemin de connexion** |
| `src/services/gAuthService.js:226` | `GET {ISSUER}/oauth/userinfo` | **chemin de connexion** |
| `src/models/Notification.js:121` | `POST exp.host/--/api/v2/push/send` | **chaque notification créée** |
| `src/routes/notificationRoutes.js:412` | `POST exp.host/--/api/v2/push/send` | route de test |
| `src/services/ctrTracker.js:51` | `POST {RUST_RECOMMENDER_URL}/track` | suivi des interactions |
| `src/routes/trackingRoutes.js:36` | `POST {RUST_RECOMMENDER_URL}/track` | suivi des interactions |
| `src/services/forgeGithubIssue.js:24` | `POST api.github.com/…/issues` | hors chemin utilisateur |

### Avec délai d'attente — la référence à suivre

`src/services/spotifyService.js:65` (`timeout: 8000`), `:113` (`4000`), `:130`
(`8000`) ; `src/routes/infrastructureAdminRoutes.js:162` (`3500`), `:201`
(`6000`), `:229` (`2500`) ; `src/routes/nfMapRoutes.js:190`
(`AbortSignal.timeout(8000)`) ; `src/services/nfMapWebView.js:361` ;
`src/services/nfMapPinService.js:158` ;
`src/services/brain-detection/BrainDetector.js:12` et `:24` (`timeout: 1000`).

Le dépôt connaît donc parfaitement la pratique — elle est simplement appliquée
de façon inégale.

### Les deux cas qui comptent

**1. La connexion g-auth (`gAuthService.js:208` et `:226`).**

```js
const response = await fetch(new URL('/oauth/token', ISSUER), {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
  body: body.toString(),
});    // ← aucun signal, aucun délai
```

Les deux appels sont enchaînés dans `gAuthController.callback`
(`src/controllers/gAuthController.js:70-71`), c'est-à-dire dans le gestionnaire
de `GET /api/g-auth/callback` — la route sur laquelle **toute connexion par
g-auth** passe. Si le fournisseur d'identité devient lent sans tomber, chaque
tentative de connexion ouvre une requête qui ne se ferme jamais. Les
utilisateurs réessaient — c'est ce qu'on fait quand une connexion « rame » — et
chaque essai ajoute une requête bloquée. La panne du fournisseur devient une
panne de l'API, avec un effet d'amplification par les nouvelles tentatives.

**2. L'envoi push (`Notification.js:121`).**

```js
await axios.post('https://exp.host/--/api/v2/push/send', payload, {
  headers: { 'Content-Type': 'application/json' }
});     // ← aucun `timeout`
```

Cet appel est fait **à l'intérieur de `Notification.createNotification`**, donc
une fois par notification créée. Croisé avec R3-07 (`tweetRoutes.js:1603`), où
`createNotification` est appelé **en série, une fois par abonné** : si `exp.host`
ralentit, la diffusion d'un seul tweet occupe une connexion base et un contexte
d'exécution pour une durée qui n'a plus aucune borne. Le `try/catch` qui entoure
l'appel attrape bien les erreurs — mais un appel qui n'échoue pas n'est jamais
attrapé, il est attendu. C'est exactement la forme de panne que le commentaire
« non bloquant » suppose impossible.

### Correctif

Une ligne par site. Pour `axios` :

```js
await axios.post(url, payload, { headers: { … }, timeout: 5000 });
```

Pour le `fetch` global (Node ≥ 18) :

```js
const response = await fetch(url, { …, signal: AbortSignal.timeout(5000) });
```

C'est déjà la forme employée par `nfMapRoutes.js:190` — il n'y a rien à
inventer, seulement à généraliser. Ordre suggéré : `gAuthService.js` (les deux),
puis `Notification.js`, puis les deux traceurs.

**Filet de sécurité durable :** plutôt que de compter sur la vigilance à chaque
nouvel appel, exporter un client unique déjà configuré
(`axios.create({ timeout: 5000 })`, et un `httpGet`/`httpPost` enveloppant
`fetch` avec `AbortSignal.timeout`), et faire de son usage la règle. Le problème
se reposera sinon au prochain appel ajouté.

**Note de robustesse.** Un délai d'attente transforme une attente infinie en
erreur — encore faut-il que l'erreur soit visible. Les `catch` de ces appels
seront à recouper avec la section B2 (erreurs avalées).

**Gain :** supprime une classe entière de blocages où la panne d'un service
tiers devient une panne de l'API. Coût : sept lignes.

---

## R4-02 — `bcryptjs` (implémentation **pure JavaScript**) au coût 12, sur le fil principal

**Où :** `src/models/User.js:2` (`require('bcryptjs')`), `:8`
(`comparePassword`), `:651` et `:661` (hooks `beforeCreate` / `beforeUpdate`,
`genSalt(12)`). Appelé depuis `src/routes/authRoutes.js:251`,
`src/services/authService.js:266` (connexion) et `:904` (changement de mot de
passe).

```json
// package.json:45
"bcryptjs": "^2.4.3",
```

**Ce qui ne va pas.** `bcryptjs` — à ne pas confondre avec `bcrypt`, qui est un
module natif — est une réimplémentation **entièrement en JavaScript**. Il n'y a
donc aucun code natif, aucun fil d'exécution séparé, aucun recours au pool de
travail de libuv : **tout le calcul se fait sur le fil principal de Node**, en
concurrence directe avec le traitement de toutes les autres requêtes.

Le facteur de coût est 12, soit 2¹² = 4 096 tours de l'algorithme, et il est
appliqué aux deux bouts :

- **inscription** — `beforeCreate` : `genSalt(12)` puis `hash` ;
- **connexion** — `comparePassword` : un `bcrypt.compare` complet, y compris
  quand le mot de passe est faux.

L'API asynchrone de `bcryptjs` découpe le travail en tranches ordonnancées par
`setImmediate` : elle évite le blocage d'un seul bloc, mais elle **n'en réduit
pas le coût**. Le fil principal reste occupé du début à la fin — il alterne
simplement entre le hachage et les autres rappels. Du point de vue du débit, la
différence est nulle : c'est du temps CPU pris à toutes les requêtes en cours.

**Effet concret — mesuré, pas supposé.** J'ai installé `bcryptjs@2.4.3` (la
version exacte du `package.json`) dans un répertoire de travail séparé et je
l'ai chronométré sous Node v22.22.2, sur une machine à 4 cœurs :

```
bcryptjs hash   coût=12          : 335 ms
bcryptjs compare (mot de passe faux) : 321 ms
```

Deux choses à en tirer, dont une qui **corrige une intuition courante** :

1. **Le coût brut n'est pas anormal.** ~330 ms au coût 12, c'est du même ordre
   qu'une implémentation native. L'idée reçue selon laquelle `bcryptjs` serait
   plusieurs fois plus lent ne se vérifie pas ici : sur V8 moderne, l'écart
   s'est largement refermé. **Ce n'est donc pas un problème de lenteur.**
2. **C'est un problème de *lieu d'exécution*.** Ces 330 ms sont pris sur le fil
   principal. Deuxième mesure, avec un `setInterval(…, 10)` qui tourne pendant
   le hachage asynchrone :

```
durée hash async : 342 ms | ticks du timer pendant : 4 | retard max de la boucle : 93 ms
```

Un intervalle de 10 ms aurait dû se déclencher ~34 fois en 342 ms. Il s'est
déclenché **4 fois**. Autrement dit, pendant un hachage, la boucle d'événements
perd près de **90 % de sa capacité**, et le pire blocage d'un seul tenant est de
**93 ms** — bien au-delà du seuil (~50 ms) à partir duquel un blocage devient
perceptible sur les autres requêtes. Le découpage par `setImmediate` de l'API
asynchrone existe bien, mais ses tranches sont grosses.

**Traduction en charge.** Trois connexions simultanées suffisent à saturer une
seconde entière de fil principal. Pendant ce temps, les requêtes de fil, de
recherche et de messagerie ne sont pas *ralenties par la base* — elles ne sont
tout simplement **pas exécutées**, faute de temps CPU. Le symptôme observable
est une latence globale qui monte en même temps que le trafic d'authentification
(pics de connexion du matin, retour d'une panne, redémarrage d'application
mobile), sans qu'aucune requête SQL ne paraisse en cause. C'est un ralentissement
**global**, pas limité à la route d'authentification, et il est trompeur à
diagnostiquer.

Deux aggravations :

1. Le calcul est fait **avant** toute vérification bon marché — un mot de passe
   faux coûte exactement aussi cher qu'un bon. C'est voulu (comparaison à temps
   constant), mais cela signifie qu'un flot de tentatives ratées coûte le plein
   tarif. À recouper avec la limitation de débit sur la connexion, qui relève de
   la section S3.
2. Les hooks `beforeCreate`/`beforeUpdate` s'exécutent **dans la transaction**
   de création du compte, quand il y en a une : le temps de hachage est aussi du
   temps de transaction ouverte. À recouper avec B1.

**Correctif, par ordre de rentabilité :**

1. **Passer à une implémentation native** : `bcrypt` (module natif, API
   compatible — le changement se limite à la ligne `require` de
   `src/models/User.js:2` et à `package.json`) ou, mieux, `argon2`. Les deux
   exécutent le calcul dans le **pool de travail de libuv**, c'est-à-dire hors
   du fil principal : le hachage cesse de concurrencer le reste du trafic. C'est
   le correctif décisif, et il est presque sans code.

   *Attention à la migration :* les empreintes déjà stockées restent lisibles
   par le module natif (même format `$2a$`/`$2b$`), donc aucune reprise de
   données n'est nécessaire — mais il faut le vérifier sur un échantillon avant
   de déployer, `bcryptjs` produisant par défaut des empreintes `$2a$`.

2. **Si le module natif est impossible** (contrainte de déploiement, absence de
   chaîne de compilation), déporter le hachage dans un `worker_thread`. Plus de
   code, même effet.

3. Ne **pas** baisser le facteur de coût pour gagner du temps : c'est le seul
   paramètre qui protège les mots de passe stockés. Le coût 12 est un bon
   réglage ; c'est le lieu d'exécution qu'il faut changer, pas la difficulté.

**Gain :** libère le fil principal de la totalité du travail cryptographique.
C'est le constat de cette section dont l'effet est le plus large : il ne
concerne pas une route, il concerne **toutes** les requêtes servies pendant
qu'une connexion est en cours.

---

## R4-03 — Sauvegarde de l'index de similarité : `writeFileSync` de ~300 Mo **toutes les 5 minutes**

**Où :** `src/services/similarity/vectorEngine.js:394-431` (`save()`),
déclenché par `src/services/similarity/recommendationEngine.js:278`
(`setInterval(() => this._periodicSave(), SAVE_INTERVAL_MS)` avec
`SAVE_INTERVAL_MS = 5 * 60 * 1000`, ligne 82), qui sauvegarde **deux** index
(`this.tweetStore.save()` et `this.userStore.save()`, lignes 1738-1739).
Également appelé après chaque reconstruction (lignes 818-819) et depuis
`src/services/userSimilarityService.js:101`.

Le moteur tourne **dans le processus de l'API** : `src/server.js:1654`
(`await similarity.initialize(models)`), juste après `app.listen`. Ce n'est pas
un travailleur séparé.

```js
save() {
  …
  const buf = Buffer.alloc(totalSize);          // ← une seule allocation
  for (const [id, vec] of entries) {            // ← boucle synchrone sur tout l'index
    …
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(buf, offset);
  }
  fs.writeFileSync(filePath, buf);              // ← écriture SYNCHRONE
}
```

**Ce qui ne va pas.** `fs.writeFileSync` bloque le fil principal jusqu'à la fin
de l'écriture — pas d'ordonnancement, pas de découpage, aucune tranche rendue à
la boucle d'événements. Et la boucle de sérialisation qui la précède est
elle-même entièrement synchrone.

La taille n'est pas anecdotique : `DIMS = 768`
(`vectorEngine.js:26`), soit 3 072 octets par vecteur, plus 4 octets de longueur
et ~36 octets d'identifiant — **~3,1 Ko par entrée**. Le volume d'entrées est
donné par la reconstruction, qui charge jusqu'à `limit: 100000` tweets
(`recommendationEngine.js:414`).

**Effet concret — mesuré.** J'ai reproduit exactement la boucle de sérialisation
et l'écriture, sous Node v22.22.2 :

```
 10 000 vecteurs =  30 Mo | construction  210 ms | writeFileSync  239 ms | total   450 ms
 50 000 vecteurs = 148 Mo | construction  939 ms | writeFileSync 1068 ms | total 2 008 ms
100 000 vecteurs = 297 Mo | construction 1333 ms | writeFileSync 1367 ms | total 2 700 ms
```

Ces durées sont du **blocage total** : pendant ce temps, le processus ne répond
à rien. Pas une requête ralentie — **aucune** requête traitée. Et
`_periodicSave()` en enchaîne **deux** (tweets puis utilisateurs), donc il faut
additionner.

À l'échelle de 100 000 tweets vectorisés, cela donne, **toutes les 5 minutes**,
un gel du processus de l'ordre de 3 à 5 secondes. Sur une journée : ~288
exécutions, soit environ **15 à 25 minutes cumulées d'API totalement figée**,
réparties en gels réguliers. Un utilisateur a donc, en permanence, à peu près
1 % de chance que sa requête tombe pendant un gel — et dans ce cas elle n'est
pas lente, elle est *arrêtée* pendant plusieurs secondes, ce qui déclenche les
délais d'attente côté client et les redémarrages de l'équilibreur de charge.

C'est aussi une explication candidate pour des pics de latence périodiques qui
ne correspondent à **aucune requête SQL lente** — le symptôme classique de ce
défaut, et le plus difficile à diagnostiquer depuis les journaux de base.

**Aggravation :** `Buffer.alloc(297 Mo)` en une fois provoque en plus une
pression mémoire brutale et une probable collecte majeure derrière.

**Correctif, par ordre de rentabilité :**

1. **Rendre l'écriture asynchrone** — `await fs.promises.writeFile(filePath, buf)`.
   Une ligne. Cela supprime immédiatement la moitié du gel (le `writeFileSync`),
   et laisse la sérialisation, qui reste synchrone. Il faut alors que `save()`
   devienne `async` et que ses trois appelants l'attendent.
2. **Sérialiser et écrire par tranches** — un flux (`fs.createWriteStream`) avec
   un `await` tous les N milliers d'entrées. Cela supprime aussi le second gel
   *et* le pic mémoire, puisqu'on n'alloue plus 300 Mo d'un bloc.
3. **Écrire de façon atomique** — écrire dans `${filePath}.tmp` puis
   `fs.promises.rename`. En l'état, un redémarrage pendant l'écriture laisse un
   `.vdb` tronqué ; `load()` (ligne 437) le relira au démarrage suivant. Je n'ai
   pas vérifié son comportement exact sur un fichier tronqué — mais c'est un
   risque gratuit à supprimer.
4. **Déplacer le moteur hors du processus de l'API** — un `worker_thread` ou un
   service séparé. C'est le seul correctif qui règle la question de fond, mais
   c'est aussi le seul qui demande un vrai travail. Les points 1 et 2 suffisent
   à faire disparaître le symptôme.

**Gain :** supprime des gels complets et périodiques du processus. Le point 1
seul coûte une ligne et retire environ la moitié du blocage — c'est le meilleur
rapport de toute la section.

---

## R4-04 — Synchronisation horaire du moteur de similarité : un `COUNT` par utilisateur actif, dans le processus de l'API

**Où :** `src/services/similarity/recommendationEngine.js:296` (`syncWithDB`),
planifiée par `:281` (`setInterval(() => this.syncWithDB(models), 60*60*1000)`),
donc **toutes les heures dans le processus de l'API** (cf. R4-03 :
`src/server.js:1654`).

Le principe est bon — la synchronisation est **incrémentale** (`created_at >
startTs`), ce qui borne la lecture à une heure d'activité. Trois choses la
déséquilibrent malgré tout.

### a) Un `COUNT` par utilisateur actif — lignes 336-349

```js
const activeUserIds = new Set([
  ...newLikes.map(l => String(l.user_id)),
  ...newRTs.map(rt => String(rt.user_id))
]);

for (const uid of activeUserIds) {
  const dbLikeCount = await TweetLike.count({ where: { user_id: uid } });   // ← 1 requête / utilisateur
  const memInteractions = this.userInteractions.get(uid);
  const memLikeCount = memInteractions ? memInteractions.size : 0;
  if (dbLikeCount < memLikeCount - 1) {
    await this.recalculateUserVector(uid, models);                          // ← 4 requêtes de plus
  }
}
```

La boucle est **séquentielle** et son cardinal est le nombre d'utilisateurs
ayant aimé ou retweeté dans l'heure. À 5 000 utilisateurs actifs par heure,
c'est **5 000 `COUNT(*)` enchaînés**, uniquement pour découvrir des « unlike ».
À 2 ms l'aller-retour, la synchronisation dure 10 s en monopolisant une
connexion base — et ce, à chaque heure ronde, c'est-à-dire au moment même où le
trafic est le plus prévisible.

Et pour chaque utilisateur ayant réellement retiré un like,
`recalculateUserVector` (`:365-395`) exécute **quatre lectures d'historique
complet, sans `limit`** : tous ses likes, tous ses retweets, toutes ses
réponses, tous ses posts. Un compte ancien y déclenche à lui seul plusieurs
dizaines de milliers de lignes.

### b) Deux `findAll` sans `attributes` — lignes 318 et 326

```js
const newLikes = await TweetLike.findAll({ where: { created_at: { [Op.gt]: startTs } }, raw: true });
const newRTs   = await TweetRetweet.findAll({ where: { created_at: { [Op.gt]: startTs } }, raw: true });
```

Seuls `user_id` et `tweet_id` sont utilisés (lignes 322 et 330), mais toutes les
colonnes sont lues. Le même fichier fait pourtant correctement
`attributes: ['user_id', 'tweet_id']` ailleurs (`:455`, `:463`, `:585`) : c'est
un oubli, pas un choix.

### c) Les boucles de traitement sont synchrones

`for (const t of newTweets) await this.onNewTweet(...)` (`:313`) puis deux
boucles de `_recordInteractionInternal` : entre les `await`, tout le travail —
vectorisation comprise — se fait sur le fil principal, sans jamais rendre la
main volontairement. Sur une heure de forte activité, c'est un gel de plusieurs
centaines de millisecondes de plus, en plus de celui de R4-03.

### Le voisinage est pire — à traiter en même temps

Deux fonctions du même fichier lisent des tables **entières, sans aucun
`limit`** :

- `_loadEnrichedMeta` (`:404`), appelée à **chaque démarrage** (`:267`) :
  `TweetLike.findAll({ attributes: ['user_id','tweet_id'], raw: true })`
  (`:455`) et `TweetRetweet.findAll(…)` (`:463`) — **toute la table des likes,
  toute la table des retweets**, suivies de boucles synchrones qui construisent
  un `Map` de `Set`.
- `_loadFollowGraph` (`:577`) : `UserFollow.findAll({ where: { status:
  'active' }, … })` — **tout le graphe social**, puis une boucle synchrone.

Ces trois lectures ne sont pas périodiques (démarrage, ou reconstruction), donc
elles ne gèlent pas l'API en régime établi. Mais elles fixent un plafond dur :
au-delà d'une certaine taille, le processus ne peut plus démarrer — mémoire
insuffisante, ou démarrage si long que l'orchestrateur le tue avant qu'il ne
réponde à sa sonde de vivacité. C'est le même mécanisme que R3-10 : une panne
différée, pas une lenteur.

### Correctif

1. **Supprimer la boucle de `COUNT`** — remplacer les 5 000 requêtes par une
   seule agrégation :
   `SELECT user_id, COUNT(*) FROM tweet_likes WHERE user_id = ANY(:ids) GROUP BY user_id`.
   Un aller-retour au lieu de N. C'est le geste rentable de ce constat.
2. **Ajouter les `attributes`** aux deux `findAll` des lignes 318 et 326 — deux
   lignes, en recopiant ce que fait déjà `:455`.
3. **Borner `recalculateUserVector`** : `limit` sur les quatre lectures
   d'historique, ou reconstruction à partir d'un agrégat plutôt que de la liste
   complète.
4. **Paginer `_loadEnrichedMeta` et `_loadFollowGraph`** par tranches, avec un
   `await` entre chaque, pour rendre la main à la boucle d'événements pendant le
   démarrage.
5. Et, à terme, le correctif de fond commun avec R4-03 : **sortir ce moteur du
   processus de l'API**.

**Gain :** supprime une rafale horaire de milliers de requêtes séquentielles sur
le processus qui sert les utilisateurs, et repousse le plafond de démarrage.

---

## R4-05 — Le pool de travail de libuv (4 fils par défaut) partagé entre traitement d'image, fichiers et DNS

**Où :** les six chemins d'envoi de média — `src/routes/userRoutes.js:1392`
(avatar) et `:1447` (bannière), `src/routes/storyRoutes.js:544`,
`src/routes/messageRoutes.js:1747`, `src/services/tweetImageService.js:76`,
`src/services/eventPass/wallet.js:111`, `src/services/nfMapPinService.js:215`,
`:312`, `:392`.

**Ce qui est déjà bien fait, et qu'il ne faut pas casser.** `sharp` n'exécute
pas son travail sur le fil principal : le décodage et le ré-encodage se font
dans du code natif (libvips), hors JavaScript. Le décodeur HEIF
(`src/services/heifDecoder.js`) est lui aussi exemplaire — `fs.promises`
partout, `execFile` **avec** un délai d'attente (`CONVERT_TIMEOUT_MS = 20_000`,
`:59`), nettoyage des fichiers temporaires dans un `finally`. Il n'y a aucun
`execSync` ni `spawnSync` dans tout `src/`. Ce n'est donc **pas** un constat de
blocage du fil principal.

**Ce qui pose problème.** Les opérations `sharp` sont dépêchées sur le **pool de
travail de libuv**, dont la taille par défaut est de **4 fils**. Or ce même pool
sert aussi :

- toutes les opérations `fs` asynchrones (`fs.promises.writeFile`,
  `readFile`… — le décodeur HEIF en fait trois par image) ;
- les résolutions DNS via `dns.lookup`, c'est-à-dire **tous les appels HTTP
  sortants** (`exp.host`, `api.spotify.com`, le fournisseur g-auth, le
  recommandeur Rust) ;
- `zlib`, donc la compression des réponses si elle est activée.

`UV_THREADPOOL_SIZE` n'est défini **nulle part** dans le dépôt : ni dans
`env.example`, ni dans `deploy/`, ni dans les scripts de démarrage. La valeur
par défaut s'applique donc.

**Effet concret.** Il suffit de **quatre envois d'image simultanés** pour que le
pool soit plein. Les tailles autorisées ne sont pas petites :
30 Mo pour les stories (`storyRoutes.js:45`) et les messages
(`messageRoutes.js:33`), 15 Mo pour les images de tweet
(`tweetImageService.js:48`). Le redimensionnement d'un JPEG de 30 Mo occupe un
fil pendant plusieurs centaines de millisecondes ; une photo iPhone y ajoute
trois entrées/sorties fichier et un processus `heif-convert`.

Pendant ce temps, **une résolution DNS pour envoyer une notification push
attend dans la même file**. Le symptôme est déroutant : les envois push, les
appels Spotify et les connexions g-auth deviennent lents alors qu'aucun de ces
services tiers n'a de problème — la latence vient d'une file d'attente locale
dont le nom n'apparaît dans aucune mesure applicative. Combiné à R4-01 (ces
mêmes appels n'ont pas de délai d'attente), l'attente peut se prolonger sans
qu'aucune erreur ne soit jamais levée.

**Je signale une incertitude.** Je n'ai pas pu mesurer ici : `sharp` n'est pas
installé dans cet environnement d'audit, et je ne connais pas le nombre de cœurs
des machines de production. Le mécanisme décrit (pool partagé, 4 fils par
défaut, `dns.lookup` dedans) est certain ; **l'ampleur réelle dépend de la
concurrence d'envois observée**, que je n'ai pas.

**Correctif.**

1. **Augmenter le pool** — une variable d'environnement, aucune ligne de code :
   `UV_THREADPOOL_SIZE=16` (ou `nombre de cœurs × 2`) dans l'unité systemd ou le
   fichier d'environnement. C'est le geste à faire en premier : coût nul,
   réversible, effet immédiat.
2. **Vérifier avant de conclure** — instrumenter avec
   `perf_hooks.monitorEventLoopDelay()` et un compteur de traitements d'image en
   cours. Si la file se remplit vraiment, le point 3 devient justifié.
3. **Isoler le traitement d'image** — le sortir vers un service ou un
   travailleur dédié, pour que la charge d'encodage ne partage plus de file avec
   le DNS et les fichiers. C'est le correctif de fond, et il rejoint celui de
   R4-03 et R4-04 : le processus de l'API fait aujourd'hui trop de choses qui ne
   sont pas « servir des requêtes ».
4. **Détail mineur, tant qu'on y est :** `tweetImageService.js:66` appelle
   `fs.mkdirSync` à **chaque** envoi d'image. Sur un répertoire qui existe déjà,
   c'est un appel système de quelques microsecondes — négligeable, mais c'est
   bien un appel synchrone sur un chemin de requête, et il suffirait de le faire
   une fois au chargement du module.

**Gain :** une variable d'environnement supprime un point de contention qui
touche, indirectement, tous les appels sortants de l'API.

---

## R4-06 — Recherche vectorielle : parcours linéaire **synchrone** de tout l'index, sur le chemin du fil

**Où :** `src/services/similarity/vectorEngine.js:352` (`search()`), appelée
depuis `src/services/similarity/recommendationEngine.js:1176`
(`getRecommendations`, phase « Collaborative Filtering »), `:1526`
(`getSimilarUsers`) et `:1551` (suggestions d'abonnement).
`getRecommendations` est elle-même appelée depuis
`src/routes/recommendationRoutes.js:182`, donc **dans le gestionnaire de
requête**, sans `await` intermédiaire.

```js
search(queryVec, k = 20, exclude = null) {
  const candidates = [];
  for (const [id, vec] of this.index) {        // ← tout l'index, en une fois
    if (exclude && exclude.has(id)) continue;
    const score = cosineSim(queryVec, vec);     // ← 768 multiplications-additions
    candidates.push({ id, score });             // ← un objet alloué par entrée
  }
  return topK(candidates, k);
}
```

**Ce qui ne va pas.** C'est une boucle JavaScript pure, sans le moindre point de
reprise : ni `await`, ni `setImmediate`, ni découpage. Tant qu'elle tourne, le
processus ne fait **rien d'autre**. `DIMS = 768` (`vectorEngine.js:26`), donc le
coût est de 768 opérations flottantes par entrée d'index, plus une allocation
d'objet `{ id, score }` par entrée — y compris pour les 99,98 % qui seront
jetés par `topK`.

**Effet concret — mesuré.** J'ai reproduit `vecDot` et `topK` à l'identique
(Node v22.22.2, `k = 20`) :

```
 10 000 vecteurs : search() =  20 ms
 50 000 vecteurs : search() = 134 ms
100 000 vecteurs : search() = 169 ms
```

169 ms de gel complet, pour **un** appel. Or `getRecommendations` en déclenche
un par calcul de fil, et les suggestions d'abonnement en déclenchent un autre.

**L'atténuation existante, et sa limite.** `getRecommendations` a un cache d'une
minute (`recommendationEngine.js:1054-1058`, `Date.now() - cached.ts < 60000`),
avec une clé par utilisateur. Le parcours n'a donc lieu qu'**une fois par
utilisateur et par minute** — c'est ce qui rend la situation actuellement
tenable, et c'est à souligner.

Mais cette atténuation se dégrade dans le mauvais sens : le nombre de parcours
par seconde vaut *utilisateurs actifs ÷ 60*. À 1 000 utilisateurs actifs, c'est
~17 parcours par seconde ; à 169 ms chacun, cela réclame **2,8 secondes de fil
principal par seconde écoulée**. Le processus est alors saturé par la seule
recherche vectorielle, et plus rien d'autre ne passe. Le point de rupture
n'arrive pas progressivement : tant que le produit `utilisateurs actifs ×
taille d'index` reste sous le seuil, tout va bien ; au-delà, l'API s'arrête.

Le cache repousse le mur, il ne le supprime pas — et il le rend plus brutal,
parce qu'il masque la montée jusqu'au dernier moment.

**Correctif, par ordre de rentabilité :**

1. **Ne pas allouer ce qu'on jette.** Remplacer le tableau `candidates` par un
   tas borné à `k` : on ne conserve jamais plus de 20 objets au lieu de 100 000.
   Cela supprime la pression mémoire et la collecte qui suit, pour ~15 lignes.
   Le calcul des produits scalaires, lui, reste entier.
2. **Rendre la main pendant le parcours** — découper la boucle par tranches de
   quelques milliers d'entrées avec un `await new Promise(setImmediate)` entre
   chaque. `search()` devient asynchrone (ses trois appelants sont déjà dans du
   code `async`). Le coût total ne baisse pas, mais il cesse d'être un gel : les
   autres requêtes retrouvent des créneaux d'exécution. **C'est le correctif qui
   change la nature du problème**, et il doit venir avant toute optimisation
   arithmétique.
3. **Réduire le nombre de candidats avant de calculer** — pré-filtrer par langue,
   fraîcheur ou groupe de recommandation. Les métadonnées nécessaires sont déjà
   en mémoire (`this.tweetMeta`). Diviser le nombre de candidats par 10 divise le
   coût par 10, sans changer l'algorithme.
4. **À terme, un index approché** (HNSW, IVF) ou une extension PostgreSQL
   (`pgvector`), qui répond en temps logarithmique plutôt que linéaire. C'est le
   vrai correctif, et le plus coûteux à mettre en place ; les points 1 à 3 le
   rendent non urgent.

**Note.** Ce constat, R4-03 et R4-04 pointent tous les trois vers le même
endroit : le moteur de similarité vit **dans** le processus qui sert les
requêtes. Chacun se corrige séparément, mais la cause commune est celle-là.

**Gain :** supprime des gels de ~170 ms sur le chemin du fil, et repousse un
seuil de saturation qui, aujourd'hui, arriverait sans prévenir.

---

## R4-07 — `_persistInteractions` : lecture, déduplication **O(n²)** et écriture **synchrones**, sur le chemin du fil IA

**Où :** `src/services/vectorStoreService.js:198-233`, appelée depuis
`:144` (`recordInteraction`), elle-même appelée depuis
`src/routes/aiRecommendationRoutes.js:123` — **dans la boucle d'enrichissement
de la route de recommandation IA**, une fois par tweet renvoyé — et depuis
`:255` (route de retour utilisateur).

```js
async _persistInteractions(userId) {
  const filePath = path.join(this.dataDir, `interactions_${userId}.json`);

  let existing = [];
  if (fs.existsSync(filePath)) {                                   // ← synchrone
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));      // ← synchrone
  }

  const merged = [...existing, ...interactions];
  const unique = merged.filter((item, index, self) =>              // ← O(n²)
    index === self.findIndex(t =>
      t.user_id === item.user_id && t.tweet_id === item.tweet_id &&
      t.action === item.action && t.timestamp === item.timestamp));

  const trimmed = unique.slice(-5000);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf8');   // ← synchrone
}
```

La fonction est déclarée `async`, mais **rien à l'intérieur ne l'est** : les
quatre opérations coûteuses sont toutes synchrones. Le mot-clé `async` ne rend
pas asynchrone ce qui ne l'est pas — il donne seulement l'apparence d'un travail
différé. C'est la forme la plus trompeuse de blocage, parce qu'elle passe la
relecture.

**Trois défauts empilés :**

1. **`filter` + `findIndex` = quadratique.** Pour chaque élément, on reparcourt
   toute la liste. Le plafond est de 5 000 entrées conservées, mergées avec
   jusqu'à 1 000 entrées en mémoire (`:137`) : ~6 000 éléments, soit ~36 millions
   de comparaisons de 4 champs.
2. **Le cache mémoire n'est jamais vidé après écriture.** `interactionVectors`
   conserve sa liste ; à la persistance suivante, **les mêmes interactions sont
   relues, refusionnées et redédupliquées**. Le travail est intégralement refait
   à chaque fois, et c'est précisément ce qui maintient `merged` au maximum.
3. **`JSON.stringify(trimmed, null, 2)`** — le fichier est indenté alors qu'il
   n'est jamais lu par un humain : environ trois fois plus d'octets à produire et
   à écrire, pour rien.

**Effet concret — mesuré** (Node v22.22.2, structure d'interaction identique) :

```
1 000 interactions : lecture+parse  1 ms | dedup O(n²)  7 ms | stringify+écriture 1 ms | TOTAL   9 ms | 155 Ko
5 000 interactions : lecture+parse  6 ms | dedup O(n²) 76 ms | stringify+écriture 3 ms | TOTAL  85 ms | 780 Ko
```

**85 ms de gel complet**, une fois le plafond atteint. Et la croissance est
quadratique : c'est 9 ms à 1 000 et 85 ms à 5 000 — multiplier la taille par 5
multiplie le coût par 9.

La persistance ne se déclenche qu'une fois sur 50 (`:143`,
`length % 50 === 0`), ce qui limite la casse — mais la route IA enregistre une
interaction **par tweet renvoyé** : un utilisateur qui fait défiler deux pages
de fil franchit le seuil. En pratique, un lecteur actif provoque un gel de
~85 ms toutes les une à deux pages, et ces gels ne sont pas répartis : ils
arrivent pendant les pics de lecture, quand tout le monde fait défiler.

**Aggravation au démarrage.** `loadPersistedInteractions` (`:241-256`) fait
`fs.readdirSync` du répertoire puis un `fs.readFileSync` + `JSON.parse`
**synchrones pour chaque fichier**, un par utilisateur, sans limite. À
100 000 utilisateurs, ce sont 100 000 fichiers d'un maximum de 780 Ko lus en
série avant que le processus ne soit prêt. Même mécanisme de plafond dur que
R4-04.

**Correctif.**

1. **Remplacer la déduplication par un `Set` de clés** — de O(n²) à O(n), pour
   trois lignes :

   ```js
   const seen = new Set();
   const unique = merged.filter((i) => {
     const key = `${i.user_id}|${i.tweet_id}|${i.action}|${i.timestamp}`;
     return !seen.has(key) && seen.add(key);
   });
   ```

   À lui seul, ce point ramène les 76 ms mesurés à moins d'une milliseconde.
   C'est le meilleur rapport effet/effort de toute la section R4.

2. **Vider le tampon mémoire après une persistance réussie** — le travail cesse
   d'être refait à chaque fois, et `merged` reste petit.

3. **Passer aux entrées/sorties asynchrones** — `fs.promises.readFile` /
   `writeFile`, avec une file d'écriture sérialisée par utilisateur.
   `src/services/searchSummaryService.js:88` (`persistCache`) implémente déjà
   exactement ce motif dans ce dépôt : il n'y a qu'à le reprendre.

4. **Supprimer l'indentation** — `JSON.stringify(trimmed)` sans le `null, 2`.
   Un caractère retiré, un tiers des octets en moins.

5. **Rendre `loadPersistedInteractions` asynchrone et paresseux** — charger le
   fichier d'un utilisateur à sa première interaction, plutôt que tous les
   fichiers au démarrage.

**Gain :** les points 1, 2 et 4 sont trois modifications locales, sans
changement d'interface, qui font passer un gel mesuré de 85 ms sous la
milliseconde. C'est le correctif le plus rentable du rapport.

---

## R4-08 — `express.json({ limit: '10mb' })` appliqué à **toutes** les routes

**Où :** `src/server.js:354-355`

```js
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
```

**Ce qui ne va pas.** `JSON.parse` est **entièrement synchrone** : c'est du code
natif V8 qui ne rend jamais la main tant qu'il n'a pas fini. Un plafond de 10 Mo
appliqué globalement autorise donc, sur **n'importe quelle** route, une analyse
syntaxique bloquante de 10 Mo.

Or presque aucune route n'a besoin de ce plafond. Les envois de fichiers passent
par `multer` (`multipart/form-data`), avec leurs propres limites déjà déclarées
route par route — 30 Mo pour les stories et les messages, 15 Mo pour les images
de tweet, 5 Mo pour les avatars. Le corps JSON, lui, ne transporte que du texte
de tweet, des identifiants et des options : quelques kilo-octets.

**Effet concret — mesuré** (Node v22.22.2) :

```
JSON.parse d'un tableau d'objets de 10,0 Mo : 170 ms
JSON.parse d'un objet à 180 000 clés (3,2 Mo) : 150 ms
```

**170 ms de gel total par requête**, pendant lesquels le processus ne traite
strictement rien d'autre. Ce n'est pas de la latence ajoutée à une requête :
c'est de la latence ajoutée à **toutes** les requêtes en vol.

**Ce qui limite les dégâts aujourd'hui — et ce qui ne les limite pas.** Le
limiteur global (`src/server.js:271-285`) est bien monté **avant** les parseurs
(ligne 285 contre 354), donc le corps n'est pas analysé pour une requête
au-delà du quota : c'est le bon ordre, et il faut le conserver. Le quota est de
1 000 requêtes par 15 minutes, soit ~1,1 requête/seconde et par adresse — à
170 ms l'analyse, cela plafonne une adresse à ~19 % d'un cœur.

Il existe cependant une exemption au limiteur global (`skip`, ligne 279). Sa
portée exacte et ce qu'elle implique relèvent de la section S3 ; **le détail est
transmis au propriétaire hors de ce dépôt public**. Retenir ici seulement ceci :
le raisonnement « le limiteur protège le parseur » ne vaut pas pour tout le
trafic.

**Correctif.**

1. **Descendre le plafond global** à ce dont les routes ont réellement besoin —
   `express.json({ limit: '128kb' })` couvre très largement le plus gros corps
   JSON légitime de cette API (un tweet long avec ses métadonnées). Le temps
   d'analyse du pire cas passe alors sous les 3 ms. C'est un changement d'une
   ligne.
2. **Relever le plafond uniquement là où c'est nécessaire**, route par route :
   `router.post('/import', express.json({ limit: '10mb' }), handler)`. Il faut
   d'abord identifier ces routes — je n'en ai trouvé aucune qui justifie 10 Mo,
   mais je n'ai pas audité les 64 fichiers de routes sur ce seul critère, et je
   ne l'affirme donc pas.
3. **Vérifier d'abord, pour ne rien casser** : journaliser `Content-Length` sur
   les requêtes JSON pendant 24 h et regarder le 99,9ᵉ centile. Le plafond se
   choisit alors sur une mesure, pas sur une intuition.

**Note liée à R4-05.** `compression()` (`src/server.js:260`) fait passer les
réponses par `zlib`, qui utilise **le même pool de travail libuv** que `sharp`,
`fs` et `dns.lookup`. Réduire la taille des réponses (toute la section R3) allège
donc aussi cette file — les deux sections se renforcent.

**Gain :** un plafond réaliste divise par ~80 le pire cas d'analyse syntaxique,
pour une ligne modifiée.

---

## R4-09 — Trois écritures synchrones mineures, pour mémoire

Relevées par l'inventaire, vérifiées, et **délibérément classées comme
mineures** — elles sont notées pour qu'une prochaine passe ne refasse pas le
travail de les évaluer.

- **`src/services/tweetImageService.js:66`** — `fs.mkdirSync(TWEET_IMAGES_DIR,
  { recursive: true })` à chaque envoi d'image. Sur un répertoire déjà présent,
  c'est un appel système de quelques microsecondes. À déplacer au chargement du
  module par propreté, sans urgence.
- **`src/services/verificationService.js:378-385`** — `fs.existsSync` +
  `fs.mkdirSync` + `fs.writeFileSync(filepath, prompt)` à chaque vérification.
  Le fichier est un petit texte, donc le blocage est négligeable. Le vrai
  problème n'est pas la vitesse : ces fichiers `verification-prompt-<horodatage>.txt`
  s'accumulent dans `temp/` **sans jamais être supprimés**. C'est une trace de
  mise au point qui remplit le disque ; à traiter en section B2 plutôt qu'ici.
- **`src/services/policiercongo/InstructionManager.js:105`, `:123` et
  `src/services/policiercongo/schedulerManager.js:81`, `:98`** — lecture et
  écriture synchrones de petits fichiers de configuration, sur des chemins
  d'administration peu appelés. Sans effet mesurable.

---

## Vérifié et trouvé SAIN

Ce qui a été regardé dans cette section et **n'appelle aucun correctif** :

**Aucun appel de processus synchrone.** Il n'y a **ni `execSync` ni `spawnSync`
nulle part dans `src/`**. Le seul lancement de processus externe est
`src/services/heifDecoder.js:96`, en `execFile` asynchrone, avec un délai
d'attente explicite (`CONVERT_TIMEOUT_MS = 20_000`, `:59`), des entrées/sorties
en `fs.promises`, et un nettoyage des fichiers temporaires dans un `finally`.
Ce module est le meilleur exemple du dépôt en matière d'entrées/sorties : c'est
lui qu'il faut copier ailleurs.

**Le traitement d'image ne bloque pas le fil principal.** `sharp` exécute
décodage et ré-encodage en code natif hors JavaScript. Le sujet de R4-05 est la
*file* qu'il partage, pas un blocage — la distinction compte pour ne pas
chercher au mauvais endroit.

**Écriture de cache déjà asynchrone et sérialisée.**
`src/services/searchSummaryService.js` : `ensureCacheLoaded` (`:68`) ne
s'exécute qu'une seule fois grâce à un drapeau, et `persistCache` (`:88`) utilise
`fs.promises` avec une file d'écriture chaînée qui empêche deux écritures
concurrentes. **C'est exactement le motif que R4-07 devrait adopter** — il est
déjà écrit, dans ce dépôt.

**Lecture synchrone au chargement du module, et pas ailleurs.**
`src/services/nfMapWebView.js:680` calcule une empreinte SHA-1 avec
`fs.readFileSync` dans une expression exécutée une seule fois à l'import — le
commentaire l'explicite (« lue une fois au démarrage »). Correct.

**Ordre des intergiciels correct.** Les limiteurs de débit (`src/server.js:285`,
`:298`, `:311`, `:330`, `:344`) sont montés **avant** les parseurs de corps
(`:354`). Une requête au-delà du quota n'atteint donc jamais `JSON.parse` — c'est
le bon ordre, et il ne faut pas l'intervertir en réorganisant le fichier.

**Le hachage de mot de passe utilise bien l'API asynchrone.**
`src/models/User.js:8`, `:651`, `:661` : aucun `hashSync`/`compareSync` sur un
chemin de requête. Le problème de R4-02 est le *lieu d'exécution*, pas un oubli
d'`await`.

**Le fil de recommandation a un cache.** `recommendationEngine.js:1054-1058`
(60 s par utilisateur) évite de refaire le parcours vectoriel à chaque requête.
C'est ce qui rend R4-06 supportable aujourd'hui ; il faut le garder en corrigeant
le reste.

---

## Récapitulatif

| # | Objet | Effet mesuré / attendu | Correctif |
|---|---|---|---|
| R4-07 | `_persistInteractions` | **85 ms** de gel, dedup O(n²), sur le fil IA | `Set` de clés + vider le tampon + `fs.promises` |
| R4-03 | sauvegarde de l'index de similarité | **2,7 s** de gel × 2, **toutes les 5 min** | `fs.promises.writeFile`, puis écriture par tranches |
| R4-06 | `search()` vectoriel | **169 ms** de gel par calcul de fil | tas borné, découpage, pré-filtrage |
| R4-02 | `bcryptjs` coût 12 | **335 ms** de CPU, **93 ms** de retard de boucle par connexion | `bcrypt` natif ou `argon2` |
| R4-01 | 7 appels réseau sans délai | attente **infinie** possible, dont sur la connexion | `timeout` / `AbortSignal.timeout` |
| R4-08 | `express.json` à 10 Mo global | **170 ms** de `JSON.parse` bloquant | plafond à 128 ko, relevé au cas par cas |
| R4-04 | `syncWithDB` horaire | milliers de `COUNT` séquentiels chaque heure | une agrégation groupée |
| R4-05 | pool libuv à 4 fils | `sharp` et `dns.lookup` dans la même file | `UV_THREADPOOL_SIZE=16` |
| R4-09 | 3 écritures synchrones mineures | négligeable | pour mémoire |

**Les trois premiers gestes, par rentabilité :**

1. **R4-07, point 1** — remplacer `filter`+`findIndex` par un `Set` de clés.
   Trois lignes, aucune modification d'interface, et 76 ms de gel mesuré
   ramenés sous la milliseconde. Rien d'autre dans ce rapport n'a ce rapport
   effet/effort.
2. **R4-03, point 1** — passer `fs.writeFileSync` en
   `await fs.promises.writeFile`. Une ligne (plus la propagation de `async` à
   trois appelants), et environ la moitié d'un gel de plusieurs secondes qui se
   répète **toutes les 5 minutes** disparaît.
3. **R4-01 et R4-05** — sept `timeout` et une variable d'environnement. Rien de
   tout cela n'accélère quoi que ce soit en régime normal : cela empêche
   simplement une panne extérieure de devenir une panne de l'API.

**Une cause racine domine.** Cinq des huit constats (R4-03, R4-04, R4-06, R4-07,
et une partie de R4-05) viennent du même choix : **les moteurs de recommandation
et de similarité vivent dans le processus qui sert les requêtes HTTP**. Chaque
constat se corrige séparément — et les correctifs proposés sont volontairement
locaux, pour être applicables tout de suite. Mais tant que ce choix tient,
chaque nouvelle fonctionnalité de recommandation prélèvera sa part du même fil
d'exécution unique, et un nouveau constat de cette forme apparaîtra.

Le déplacer vers un `worker_thread` ou un service séparé est le seul geste qui
règle la famille entière. Ce n'est pas un préalable aux correctifs ci-dessus :
c'est ce vers quoi ils font gagner du temps.

**Recoupements.** R4-01 recoupe B2 (une erreur qui n'arrive jamais ne peut pas
être journalisée) ; R4-02 recoupe B1 (hachage à l'intérieur d'une transaction)
et S3 (limitation de débit sur la connexion) ; R4-07 et R4-03 recoupent B2
(fichiers non nettoyés, écriture non atomique) ; R4-08 recoupe S3, dont le
détail est transmis au propriétaire hors de ce dépôt public.
