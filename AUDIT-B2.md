# AUDIT B2 — Robustesse : erreurs et journaux

> Section **B2** de l'audit `twitninf-api`. Périmètre : erreurs avalées sans
> trace, `catch` vides, chemins d'échec répondant `200`, journaux si bruyants
> qu'ils noient les vraies erreurs, données personnelles dans les journaux.
>
> Chaque constat est vérifié dans le code avant d'être écrit. Les incertitudes
> sont signalées explicitement. Constats classés par gain décroissant.

---

## B2-01 — `Float32Array(256)` contre `DIMS = 768` : un `console.warn` par tweet média, et ces tweets ne sont jamais vectorisés

**Gravité : haute** — c'est très probablement la source directe du symptôme
« plus d'un millier de fausses erreurs masquant les vraies » mentionné dans la
consigne d'audit, doublé d'un bug fonctionnel silencieux.

**Emplacement :** `src/services/similarity/recommendationEngine.js:711`

```js
if (!vec) {
  if (hasMedia || tweet.tweet_type === 'video') {
    vec = new Float32Array(256); // ZERO vector (DIMS = 256)
  } else {
    continue;
  }
}
```

**Ce qui ne va pas.** Le commentaire `DIMS = 256` est périmé. La constante
réelle est déclarée à `src/services/similarity/vectorEngine.js:26` :

```js
const DIMS = 768;                  // Dimension des vecteurs (E5-Base)
```

Le vecteur nul fabriqué ici fait donc 256 composantes là où l'index en attend
768. Il est ensuite passé à `this.tweetStore.upsert(tweet.id, vec)`
(`recommendationEngine.js:717`), et `VectorStore.upsert`
(`vectorEngine.js:307-318`) le rejette systématiquement :

```js
if (!(vec instanceof Float32Array) || vec.length !== DIMS) {
  console.warn(
    `⚠️ [VectorStore:${this.name}] upsert(${id}) refusé : ` +
    `attendu Float32Array(${DIMS}), reçu ...`
  );
  return false;
}
```

Le garde-fou de `upsert` fait exactement son travail : il refuse le vecteur mal
dimensionné et le signale. Le défaut est en amont, chez l'appelant.

**L'effet concret.** Il est double, et le second est le plus coûteux :

1. **Bruit dans les journaux.** `rebuildFromDB`
   (`recommendationEngine.js:676`) charge jusqu'à **50 000 tweets** en une
   passe (`limit: 50000`, `recommendationEngine.js:695`). Chaque tweet
   média/vidéo dont le texte ne se vectorise pas (légende vide, emoji seuls,
   texte entièrement composé de mots vides) traverse cette branche et émet
   **un `console.warn` de trois lignes**. Sur un corpus où les tweets
   média sans texte utile ne représenteraient que 2 % du total, cela fait déjà
   **~1 000 avertissements par reconstruction** — l'ordre de grandeur exact du
   symptôme rapporté. La reconstruction est déclenchée au démarrage quand
   l'index est vide ou que `REBUILD_SIMILARITY=true`
   (`recommendationEngine.js:269-271`), donc à chaque redémarrage à froid.
   Ces milliers de lignes noient les vraies erreurs dans la même sortie.

2. **Bug fonctionnel silencieux.** L'intention du code est explicite dans son
   propre commentaire : donner un vecteur nul aux tweets vidéo pour qu'ils
   *« puissent tout de même être recommandés par l'engagement
   (trending/collab/freshness) »*. Comme `upsert` renvoie `false`, **cette
   intention n'est jamais réalisée** : ces tweets n'entrent pas dans
   `tweetStore` et ne sont donc jamais recommandés par ce chemin. La valeur de
   retour de `upsert` n'est pas testée par l'appelant, ce qui est la raison
   pour laquelle l'échec passe inaperçu depuis si longtemps. Le compteur
   `vectorized` (`recommendationEngine.js:699`) est incrémenté sans consulter
   ce retour, donc les journaux de fin de reconstruction **annoncent comme
   vectorisés des tweets qui ne le sont pas**.

**Le correctif.** Une ligne, plus un garde-fou :

```js
// recommendationEngine.js — importer la constante au lieu de la recopier
const { DIMS } = require('./vectorEngine');   // à exporter si ce n'est pas déjà le cas
...
vec = new Float32Array(DIMS);                 // au lieu de Float32Array(256)
```

Recopier une dimension en dur dans un second fichier est ce qui a permis à la
désynchronisation de s'installer : importer la constante empêche la
récidive. Accessoirement, tester le retour de `upsert` à l'appel
(`recommendationEngine.js:717`) et n'incrémenter `vectorized` que sur succès
rendrait un futur rejet visible immédiatement, au lieu d'attendre un audit.

**Vérifié.** `DIMS = 768` lu dans `vectorEngine.js:26` ; le `!== DIMS` de
`upsert` lu dans `vectorEngine.js:310` ; le `limit: 50000` lu dans
`recommendationEngine.js:695`.
**Non mesuré :** la proportion réelle de tweets média sans texte vectorisable
en production — c'est elle qui fixe le nombre exact d'avertissements par
reconstruction. L'estimation de ~1 000 ci-dessus suppose 2 % de 50 000 et est
donnée comme ordre de grandeur, pas comme mesure.

---

## B2-02 — Le prompt de vérification, qui contient l'identité de l'utilisateur, est écrit sur disque à chaque demande, jamais supprimé, et le dossier n'est pas ignoré par git

**Gravité : critique** — donnée personnelle persistée en clair, sans purge, dans
un dossier suivi par git alors que le dépôt est public. Le détail opérationnel
et la liste des actions immédiates sont transmis au propriétaire hors dépôt.

**Emplacement :** `src/services/verificationService.js:372-388`

```js
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const tempDir = path.join(__dirname, '../../temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
const filename = `verification-prompt-${timestamp}.txt`;
const filepath = path.join(tempDir, filename);
fs.writeFileSync(filepath, prompt, 'utf8');
logger.info(`📝 Prompt verification enregistré dans: ${filepath}`);
```

**Ce qui ne va pas.** Trois défauts distincts se cumulent sur ces quinze lignes.

1. **Le contenu écrit est de la donnée personnelle.** Le prompt assemblé par
   `createVerificationPrompt` (`verificationService.js:270`) interpole le nom
   d'utilisateur et le **nom complet** (`:282-283`), les statistiques du
   compte, le **texte intégral des tweets récents** (`:297-299`) et les
   **cinq réponses libres du formulaire de vérification** (`:313-327`) —
   dont `profession` et `organization`. C'est l'identité civile déclarée du
   demandeur, écrite en clair.

2. **Aucune suppression, jamais.** Il n'existe aucun `unlink`, aucun `rmSync`,
   aucune tâche de purge dans le fichier — vérifié par recherche sur
   `unlink|rmSync|temp/` dans `verificationService.js` : zéro occurrence hors
   de l'écriture elle-même. Le nom de fichier est horodaté à la milliseconde,
   donc **aucun fichier n'écrase jamais un autre** : c'est une croissance
   strictement monotone, un fichier par demande de vérification, pour la durée
   de vie du disque.

3. **`temp/` n'est pas dans `.gitignore`.** Recherche de `temp` dans
   `.gitignore` : aucune correspondance. Conséquence directe et déjà réalisée :
   **13 de ces fichiers sont actuellement suivis par git** (`git ls-files temp/`
   en renvoie 13), donc présents dans un dépôt public. J'ai ouvert l'un d'eux
   pour vérifier avant d'écrire ce constat : il contient bien des données
   d'utilisateurs réels, pas des données de test.

**L'effet concret.** Par ordre de gravité :

- **Exposition publique de données personnelles.** L'identité déclarée de
  chaque utilisateur ayant demandé la vérification pendant la fenêtre
  concernée est lisible par n'importe qui, sans authentification, y compris
  via les miroirs et caches d'un dépôt public. Retirer les fichiers du
  répertoire de travail ne suffira pas : ils restent dans l'historique git.
- **Remplissage du disque.** Un fichier par demande, jamais purgé. Le volume
  par fichier est modeste (quelques kilo-octets), donc l'échéance est
  lointaine — mais elle est certaine, et la panne qu'elle produit
  (`ENOSPC`) frappe *toutes* les écritures du service, pas seulement
  celle-ci.
- **Bruit de journal.** Chaque écriture émet en plus un `logger.info` sur un
  chemin qui n'intéresse personne en régime normal.

**Le correctif.** Dans l'ordre où il faut l'appliquer :

1. **Traiter les données déjà publiées comme compromises** et purger
   l'historique — retirer les fichiers du suivi ne les dépublie pas. Les
   modalités sont transmises au propriétaire hors dépôt.
2. Ajouter `temp/` à `.gitignore` pour que la récidive soit impossible.
3. **Supprimer purement et simplement l'écriture sur disque.** C'est le vrai
   correctif : ce fichier est un artefact de mise au point qui a survécu à sa
   raison d'être. Si le contenu du prompt doit rester inspectable, le passer
   au `logger` en niveau `debug` (donc muet en production) est suffisant, et
   place la donnée sous la politique de rétention des journaux au lieu d'un
   dossier oublié.
4. Si l'écriture doit absolument être conservée, alors : dossier hors de
   l'arborescence du dépôt, purge par âge à chaque écriture, et **caviardage
   des champs d'identité** avant sérialisation.

**Vérifié.** L'écriture lue à `verificationService.js:384` ; l'absence totale
de suppression vérifiée par recherche dans le fichier ; l'absence de `temp`
dans `.gitignore` vérifiée ; les 13 fichiers suivis confirmés par
`git ls-files temp/` ; le caractère réel (non-test) des données confirmé par
lecture d'un fichier.
**Note de périmètre :** ce constat est écrit ici parce qu'il relève
littéralement du sujet B2 (« données personnelles dans les journaux »). Sa
face « exposition publique » sera reprise en S1, et le détail opérationnel
n'est volontairement pas publié dans ce fichier.

---

## B2-03 — L'écriture du verdict de détection de bot avale toutes ses erreurs : en mode surveillance, la détection ne laisse aucune trace

**Gravité : haute** — c'est la seule écriture durable du verdict, et son échec
est strictement invisible.

**Emplacement :** `src/services/BotDetectionService.js:180`

```js
async _updateReputation(userId, score) {
  try { await BotReputation.upsert({ user_id: userId, last_score: score, updated_at: new Date() }); } catch (e) {}
}
```

**Ce qui ne va pas.** Le `catch (e) {}` est vide : pas de `logger`, pas de
relance, pas de valeur de retour. Toute défaillance de l'`upsert` — table
absente, contrainte violée, connexion coupée, dépassement de délai du pool,
base en lecture seule pendant une bascule — est absorbée sans laisser la
moindre trace. L'appelant ne peut pas non plus détecter l'échec :
`_updateReputation` ne renvoie rien, et aucun des trois sites d'appel n'en
teste le résultat (`:130`, `:151`, `:157`).

**L'effet concret.** Il dépend du mode, et c'est en mode surveillance qu'il
est le plus grave :

- **Mode surveillance (`CONFIG.AUTO_SANCTION` désactivé)** — chemins `:130` et
  `:151`. Aucune sanction n'est appliquée : le service se contente d'écrire le
  score et de renvoyer le verdict à l'appelant. `_updateReputation` est donc
  **la seule trace durable de la détection**. Si l'`upsert` échoue, la
  détection n'a produit strictement rien : pas de ligne en base, pas de
  journal, pas d'erreur. Un compte détecté à **score 99** par l'heuristique
  rapide (`:130`, le cas « rafale extrême », le plus net qui soit) disparaît
  sans laisser de trace. Or c'est précisément ce mode qu'on utilise pour
  observer avant d'activer les sanctions : les chiffres sur lesquels reposera
  la décision d'activation sont silencieusement incomplets, et rien n'indique
  de combien.
- **Mode sanction** (`:157`) — la sanction, elle, est appliquée avant
  (`_applyProgressiveSanction`), donc l'effet immédiat survit. Mais la
  réputation persistée diverge de la réalité : le compte est sanctionné sans
  que son score soit enregistré.
- **Effet différé sur la modération.** L'enregistrement est relu par
  `src/services/policiercongo/policiercongov3/adminModerationTools.js:174`
  (`BotReputation.findByPk`). Un modérateur consultant la réputation d'un
  compte verra « aucune donnée » là où une détection a bien eu lieu, et
  conclura de bonne foi que le compte est vierge.

**Le même défaut, en lecture, une ligne plus haut.** À
`BotDetectionService.js:114`, la lecture de la réputation est protégée par
`.catch(() => null)` : une base en erreur devient indistinguable d'un compte
sans historique. C'est le même choix — dégrader silencieusement — appliqué au
chemin de lecture.

**Le correctif.** Journaliser, et remonter l'échec à l'appelant :

```js
async _updateReputation(userId, score) {
  try {
    await BotReputation.upsert({ user_id: userId, last_score: score, updated_at: new Date() });
    return true;
  } catch (e) {
    logger.error(`❌ [BotDetection] Persistance réputation échouée user=${userId} score=${score}:`, e.message);
    return false;
  }
}
```

Le choix de ne pas faire échouer la requête appelante est défendable — la
détection de bot ne doit pas casser le parcours utilisateur. Mais « ne pas
faire échouer » et « ne rien dire » sont deux décisions distinctes, et seule la
première est justifiée ici. Pour `:114`, remplacer `.catch(() => null)` par un
`catch` qui journalise avant de renvoyer `null` conserve la tolérance à la
panne sans en effacer la trace.

**Vérifié.** Le `catch (e) {}` lu à `:180` ; les trois sites d'appel lus à
`:130`, `:151`, `:157` et l'absence de test du retour confirmée ; le
`.catch(() => null)` lu à `:114` ; la relecture par les outils de modération
confirmée à `adminModerationTools.js:174`.
**Non vérifié :** la valeur effective de `CONFIG.AUTO_SANCTION` en production
— c'est elle qui décide lequel des deux effets ci-dessus s'applique
aujourd'hui.

### Autres `catch` vides relevés, par ordre d'importance décroissante

Recensés par recherche sur l'ensemble de `src/`. Ceux-ci sont réels mais d'un
enjeu inférieur au précédent :

- `src/services/videoRecommendationService.js:224` (`onFollow`) et `:255`
  (`onNewUser`) — `catch (e) {}` autour de la mise à jour du moteur de
  recommandation. Une mise à jour perdue dégrade silencieusement les
  recommandations, sans qu'aucun signal ne permette de relier la dégradation à
  sa cause. Ce qui rend l'omission certaine plutôt que délibérée : la méthode
  voisine `onNewVideo` (`:243`), rigoureusement de même forme, journalise bien
  son erreur (`logger.error('❌ [VideoReco] Failed to add new video ...')`).
  Les deux autres ont simplement été oubliées.
- `src/services/policiercongo/tweetManager.js:190` — `JSON.parse` de
  `media_urls` en `catch (e) {}`. Un champ corrompu en base donne un tweet
  rendu sans ses médias, sans trace.
- `src/services/policiercongo/` — nombreux `catch (_) {}` (`dataCollector.js:119`,
  `:225`, `:234` ; `policiercongoV2Bridge.js:329`, `:353` ;
  `actionExecutor.js:990` ; `platformTools.js:689` ;
  `geminiIntelligence.js:1296`). À traiter comme un lot : ce module a manifestement
  pour convention d'ignorer ses erreurs.
- `src/services/vectorStoreService.js` — `catch (e) { // Skip corrupt files }`.
  Un fichier d'index corrompu est ignoré en silence ; l'index se vide
  progressivement sans que rien ne l'annonce.

**Jugés sains — pour B2-03 (analysés, non retenus).** `src/middleware/fraudMiddleware.js:276`,
`:283` et `:356` : les deux premiers protègent un `JSON.stringify` dont
l'échec est sans conséquence (le champ reste vide), le troisième décode un JWT
non vérifié pour identifier l'appelant et retombe délibérément sur
`'anonymous'` si le jeton est malformé — c'est le comportement voulu, documenté
par le commentaire qui le précède, et le journaliser produirait du bruit à
chaque requête anonyme. De même,
`src/services/policiercongo/policiercongoV2.js:677` et `:685` : ces `catch`
vides encadrent des tentatives successives de `JSON.parse` sur une réponse de
modèle, où l'échec d'une tentative est la condition normale de passage à la
suivante. Les `catch { // ignore }` de `src/scripts/` ne sont pas retenus non
plus : ce sont des scripts d'administration lancés à la main, dont la sortie
est lue en direct par l'opérateur.

---

## B2-04 — 26 fonctions de scoring des recommandations renvoient une note neutre en cas d'erreur, sans rien journaliser : un moteur cassé est indistinguable d'un moteur qui marche

**Gravité : moyenne à haute** — pas de panne visible, jamais ; à la place, une
dégradation permanente de la qualité des recommandations que rien ne permet de
détecter ni de dater.

**Emplacement :** `src/services/smartRecommendationEngine.js`, 26 occurrences
entre les lignes 1730 et 2145. Forme type (`:1957`) :

```js
calculateLanguageMatch(tweet, userProfile) {
  try {
    const tweetLanguage = tweet.language || 'unknown';
    const userLanguage = userProfile.user?.language || 'fr';
    return tweetLanguage === userLanguage ? 100 : 0;
  } catch (error) {
    return 50;          // ← aucun logger, aucun compteur, aucune trace
  }
}
```

**Ce qui ne va pas.** Le fichier compte 75 blocs `catch (error)`, dont **26
renvoient une valeur par défaut sans aucune journalisation** : 11 `return 0`,
6 `return 50`, 5 `return false`, plus un `return 70`, un `return 1000`, un
`return []` et un `return null`. La variable `error` est liée puis jamais
utilisée — le motif est uniforme, ce n'est pas un oubli isolé mais une
convention appliquée à tout le module.

Le choix de ne pas propager l'erreur est raisonnable en soi : un composant de
scoring défaillant ne doit pas faire échouer le fil entier. Le défaut est
ailleurs, et il est double :

1. **La valeur de repli est indistinguable d'un résultat légitime.** `50` est
   au milieu de l'échelle 0–100 que ces fonctions produisent : un composant
   totalement cassé rend exactement ce que rend un composant en bon état face
   à un contenu moyen. `return 0` est pire encore côté effet, puisqu'il pénalise
   le tweet — mais il est tout aussi silencieux. Aucun consommateur en aval ne
   peut faire la différence, parce qu'il n'y a rien à lire pour la faire.
2. **L'erreur ne laisse aucune trace, nulle part.** Pas de `logger`, pas de
   compteur, pas même un `stats.errors++` — alors que ce compteur existe
   ailleurs dans le dépôt : `src/services/featureFlagService.js` incrémente
   `stats.errors` dans huit de ses `catch` silencieux (`:176`, `:197`, `:220`,
   `:294`, `:337`, `:372`, `:388`). Ce module-là dégrade lui aussi en silence,
   mais il **compte**, donc la dégradation est observable. Le moteur de
   recommandation ne compte pas.

**L'effet concret.** Ces notes ne sont pas consommées isolément : elles
alimentent une somme pondérée, dont les poids sont déclarés en tête de fichier
(`:44-70` — `weight: 0.35` pour la proximité sociale, `0.25` pour
l'engagement, etc.). Une seule fonction qui bascule durablement sur son repli
décale donc le score final de tous les tweets, dans le même sens, sans que le
service ne signale quoi que ce soit. Concrètement :

- Un changement de forme sur `userProfile` (un champ renommé, une association
  non chargée, un `null` là où un objet était attendu) fait basculer une ou
  plusieurs de ces fonctions sur leur repli **pour tous les utilisateurs à la
  fois**. Le fil devient moins pertinent ; les journaux restent parfaitement
  vides ; le service est « vert » sur tous les tableaux de bord.
- Le diagnostic, quand la baisse de pertinence finit par être remarquée par les
  usages, ne dispose d'**aucune date de début** ni d'aucun composant désigné.
  C'est ce qui rend ce constat coûteux : il ne provoque pas d'incident, il
  rend les incidents inexplicables.

**Le correctif.** Ne pas changer la stratégie de repli — elle est bonne — mais
la rendre observable. Le plus économique, sans toucher aux 26 sites :

```js
// une fois, en tête de classe
_scoringFallback(fnName, error, fallbackValue) {
  this.stats.scoringErrors = (this.stats.scoringErrors || 0) + 1;
  // volontairement throttlé : ces erreurs arrivent en rafale ou pas du tout
  if (this.stats.scoringErrors % 100 === 1) {
    logger.warn(`⚠️ [SmartReco] ${fnName} repli sur ${fallbackValue}:`, error.message);
  }
  return fallbackValue;
}
// puis, sur chaque site :
} catch (error) { return this._scoringFallback('calculateLanguageMatch', error, 50); }
```

L'échantillonnage (une ligne sur cent) est le point important : journaliser
sans limite ici recréerait exactement le problème de B2-01, puisque ces
fonctions sont appelées une fois par tweet et par candidat. Le compteur, lui,
doit être exposé sans échantillonnage — c'est lui qui rend la dégradation
visible, et il coûte une incrémentation.

**Vérifié.** Les 75 `catch (error)` comptés dans le fichier ; les 26 retours
silencieux dénombrés et ventilés par valeur ; les formes exactes lues à
`:1885`, `:1957`, `:1971`, `:2001` ; les poids lus à `:44-70` ; le compteur
`stats.errors` de `featureFlagService.js` vérifié aux huit lignes citées.
**Non vérifié :** si l'un de ces replis est effectivement déclenché en
production aujourd'hui — c'est précisément ce que l'absence de trace rend
impossible à déterminer depuis le code seul, et c'est l'argument central du
constat.

---

## B2-05 — L'index vectoriel est réécrit en place toutes les 5 minutes, sans écriture atomique : un redémarrage pendant l'écriture détruit un fichier de ~155 Mo

**Gravité : moyenne** — la fenêtre est étroite mais elle se rouvre 288 fois par
jour, et le coût de la perte est une reconstruction complète.

**Emplacement :** `src/services/similarity/vectorEngine.js:425-426`

```js
const filePath = path.join(this.dataDir, `${this.name}.vdb`);
fs.writeFileSync(filePath, buf);        // ← écrase directement le fichier existant
```

**Ce qui ne va pas.** `writeFileSync` sur le chemin définitif tronque le
fichier existant **avant** d'écrire le nouveau contenu. Entre la troncature et
la fin de l'écriture, le fichier sur disque est incomplet. Il n'y a ni
écriture dans un fichier temporaire suivi d'un `fs.renameSync` (qui serait
atomique sur le même système de fichiers), ni `fsync`, ni fichier de
secours.

**L'effet concret.** La taille est ce qui rend la fenêtre réelle plutôt que
théorique. Le format est décrit juste au-dessus, aux lignes 385-392 : 8 octets
d'en-tête, puis par entrée 4 octets de longueur d'identifiant, l'identifiant
UTF-8, et `DIMS * 4` octets de vecteur. Avec `DIMS = 768`, cela fait
**3 072 octets de vecteur par tweet**, soit ~3 112 octets par entrée pour un
identifiant de type UUID. Sur les 50 000 tweets que `rebuildFromDB` charge au
maximum (`recommendationEngine.js:695`), le fichier atteint donc **~155 Mo**,
écrits en un seul appel bloquant, **toutes les 5 minutes**
(`SAVE_INTERVAL_MS = 5 * 60 * 1000`, `recommendationEngine.js:82`, armé en
`setInterval` à `:278`) et une fois de plus à l'arrêt (`:1884`).

Si le processus meurt pendant cette écriture — déploiement, `SIGTERM` d'un
orchestrateur, redémarrage machine, `ENOSPC` (que B2-02 rend d'ailleurs plus
probable) — le `.vdb` reste tronqué. Au démarrage suivant, `load()` (`:437`)
lit le nombre d'entrées annoncé dans l'en-tête, puis boucle pour lire
exactement ce nombre de vecteurs. Sur un fichier tronqué, `buf.readFloatLE`
sort des bornes et lève une `RangeError`, attrapée à `:465` :

```js
} catch (err) {
  console.error(`❌ [VectorStore:${this.name}] Erreur chargement: ${err.message}`);
  return 0;
}
```

L'erreur est donc bien journalisée — c'est le point positif — mais le retour
`0` a une conséquence en cascade : l'index est vide, et
`recommendationEngine.js:269` (`if (tSize === 0 || uSize === 0 || ...)`)
déclenche une **reconstruction complète depuis la base**. Le redémarrage qui
devait durer quelques secondes recharge 50 000 tweets et les revectorise, en
émettant au passage le flot d'avertissements de B2-01. Un incident bénin
devient un démarrage long et bruyant. À noter aussi : `this.index.clear()` est
appelé à `:452` **avant** la boucle de lecture, donc un échec en cours de
route laisse l'index partiellement rempli plutôt qu'inchangé — mais comme
l'appelant traite `0` comme « vide », cet état intermédiaire n'est pas exploité.

**Le correctif.** Le motif standard, trois lignes :

```js
const filePath = path.join(this.dataDir, `${this.name}.vdb`);
const tmpPath  = `${filePath}.tmp`;
fs.writeFileSync(tmpPath, buf);
fs.renameSync(tmpPath, filePath);   // atomique sur le même système de fichiers
```

Le `rename` est atomique : à tout instant, le chemin définitif désigne soit
l'ancien fichier complet, soit le nouveau fichier complet, jamais un fichier à
moitié écrit. Il faut aussi prévoir la suppression d'un `.tmp` résiduel au
démarrage, laissé par un crash antérieur. Pour une garantie stricte contre la
coupure d'alimentation (et non seulement contre la mort du processus), il faut
en plus un `fs.fsyncSync` sur le descripteur avant le `rename` — probablement
superflu ici, l'index étant reconstructible depuis la base.

**Vérifié.** Le `writeFileSync` sur chemin définitif lu à `:426` ; l'absence de
`.tmp`/`rename` dans la fonction confirmée par lecture intégrale de `save()`
(`:394-432`) ; le format et le calcul de taille lus à `:385-392` et `:403-406` ;
`DIMS = 768` à `:26` ; l'intervalle de 5 minutes à `recommendationEngine.js:82`
et `:278` ; le `return 0` de `load()` à `:465` et son effet sur `:269`.
**Estimation :** les ~155 Mo supposent l'index plein à 50 000 entrées et des
identifiants de type UUID ; la taille réelle dépend du volume en production.
Le raisonnement tient quelle que soit la taille — elle ne fait que fixer la
largeur de la fenêtre.

---

## B2-06 — Deux canaux de journalisation coexistent : 50 `console.error` de code applicatif n'atteignent jamais `error.log`

**Gravité : moyenne à haute** — ce n'est pas du bruit, c'est du silence : la
personne qui cherche les erreurs de production à l'endroit prévu pour elles ne
les y trouve pas toutes.

**Emplacement :** transverse. `src/utils/logger.js` d'un côté ; 373 appels
`console.*` de l'autre.

**Ce qui ne va pas.** Le dépôt dispose d'un logger `winston` correctement
configuré (`src/utils/logger.js`), avec trois transports : la console, un
fichier général `logs/app.log`, et — c'est le point important — un fichier
dédié **`logs/error.log` filtré sur `level: 'error'`** (`:32-36`). Le format
fichier est structuré (`timestamp` + `errors({ stack: true })` + `json()`,
`:6-10`), et le niveau global est piloté par `config.logging.level`, valant
`'info'` (`src/config/config.js:100`).

Ce dispositif est bon. Le problème est que **tout le code n'y passe pas**. Le
dépôt compte 3 600 appels `logger.*` et **373 appels `console.*`**. Les seconds
n'atteignent aucun transport winston : ils écrivent directement sur
`stdout`/`stderr`. Trois conséquences en découlent mécaniquement :

1. **Ils sont absents de `logs/error.log`.** Hors scripts d'administration et
   fichiers de test, **50 `console.error` subsistent dans le code applicatif** —
   dont 10 dans `src/services/similarity/recommendationEngine.js`, 9 dans
   `src/controllers/eventController.js`, 7 dans `src/routes/userStatsRoutes.js`,
   2 dans `src/services/similarity/vectorEngine.js` (dont l'échec de chargement
   d'index de B2-05, et l'échec de sauvegarde). Ce sont de vraies erreurs, et
   le fichier censé les rassembler ne les contient pas. Quiconque diagnostique
   un incident en lisant `error.log` — le réflexe correct — conclura à tort que
   ces composants n'ont rien signalé.
2. **Ils échappent au niveau de log.** `config.logging.level` ne les filtre
   pas : les `console.log` de débogage sont émis en production exactement comme
   en développement. C'est ce qui rend le flot de B2-01 (un `console.warn` par
   tweet média) impossible à faire taire autrement qu'en modifiant le code.
3. **Ils ne sont pas structurés.** Pas d'horodatage, pas de JSON, pas de pile
   d'appel. Dans un flux où toutes les autres lignes sont du JSON horodaté, ces
   373 lignes sont illisibles par un collecteur, et cassent l'analyse
   automatique du flux.

**L'effet concret.** Les deux défauts se combinent de la pire manière : les
`console.log` bavards saturent `stdout` (canal 2), pendant que les `console.error`
graves manquent à `error.log` (canal 1). C'est exactement la forme du symptôme
décrit dans la consigne d'audit — « des journaux si bruyants qu'ils noient les
vraies erreurs » — mais avec une cause supplémentaire : ici, une partie des
vraies erreurs n'est même pas dans le fichier où on va les chercher.

**Le correctif.** Par ordre de rentabilité :

1. **Remplacer les 50 `console.error` applicatifs par `logger.error`.**
   C'est mécanique, sans risque, et cela suffit à rendre `error.log` complet.
   À faire en premier, avant tout le reste.
2. Convertir les `console.log`/`console.warn` des services en
   `logger.debug`/`logger.warn`, ce qui les place enfin sous le contrôle de
   `config.logging.level` (et éteint le flot de B2-01 en production sans
   toucher à sa logique).
3. Poser un garde-fou pour empêcher la récidive : une règle ESLint
   `no-console`, avec exception explicite pour `src/scripts/` — les scripts
   d'administration sont lancés à la main et leur sortie est lue en direct, la
   console y est le bon canal.

**Point d'attention sur la rétention.** Les deux transports fichier sont
plafonnés à `maxsize: 5242880` (5 Mo) et `maxFiles: 5`
(`logger.js:26-27` et `:34-35`), soit **25 Mo de rétention par fichier**. Sur
un service qui journalise abondamment, une rafale d'erreurs répétitives peut
faire tourner `error.log` assez vite pour évincer les erreurs antérieures —
donc pour effacer le début d'un incident pendant qu'on l'analyse. Je ne peux
pas dire depuis le code seul si ce plafond est atteint en production : cela
dépend du volume réel. À vérifier côté exploitation ; si les fichiers tournent
en moins de quelques jours, augmenter `maxFiles` est un correctif à un
caractère.

**Vérifié.** Les trois transports et le filtre `level: 'error'` lus dans
`logger.js:14-37` ; le format structuré à `:6-10` ; `level: 'info'` lu dans
`config/config.js:100` ; les décomptes 373 `console.*` / 3 600 `logger.*`
obtenus par recherche sur `src/` ; les 50 `console.error` applicatifs obtenus
par la même recherche en excluant `src/scripts/` et les fichiers de test, et
ventilés par fichier.
**Non vérifié :** le volume de journalisation réel en production, seul élément
qui permettrait de dire si le plafond de rétention de 25 Mo est effectivement
atteint.

---

## B2-07 — « Mot de passe oublié » répond `200 OK` en annonçant un email qui n'est jamais envoyé

**Gravité : haute** — un parcours utilisateur entier est hors service, et l'API
affirme le contraire à chaque appel. Aucun journal ne signale l'anomalie, parce
que du point de vue du code il ne s'est rien passé d'anormal.

**Emplacement :** `src/services/authService.js:458-463`

```js
await user.save();

// TODO: Envoyer l'email avec le lien de réinitialisation

logger.info(`Demande de réinitialisation de mot de passe pour: ${user.email}`);

return { success: true, message: 'Si l\'email existe, un lien de réinitialisation a été envoyé' };
```

**Ce qui ne va pas.** Le service fabrique un jeton de réinitialisation
(`jwt.sign`, `:448`), le stocke sur l'utilisateur avec une expiration à une
heure (`:455-456`), l'enregistre — **puis ne l'envoie nulle part**. L'envoi est
un `TODO` jamais honoré. La fonction renvoie néanmoins `success: true` avec le
message *« Si l'email existe, un lien de réinitialisation a été envoyé »*, et
le contrôleur le transmet tel quel en `200`
(`src/controllers/authController.js:194-195`) sur la route publique
`POST /forgot-password` (`src/routes/authRoutes.js:291`).

J'ai vérifié qu'aucun autre chemin ne rattrape l'envoi : une recherche sur
`sendMail|nodemailer` dans tout `src/` (hors scripts) ne renvoie **aucune
occurrence**. La dépendance `nodemailer` est pourtant bien déclarée
(`package.json:65`) et une configuration SMTP existe
(`src/config/config.js:105-107`, `smtp.gmail.com`) : tout a été préparé, seul
le branchement manque. La formulation prudente du message — celle qu'on emploie
justement pour ne pas révéler si un compte existe — masque parfaitement le
fait qu'aucun envoi n'a lieu, y compris quand l'email existe.

**L'effet concret.**

- **Aucun utilisateur ne peut récupérer son compte.** Celui qui perd son mot de
  passe reçoit une confirmation rassurante, attend un email qui n'arrivera
  jamais, recommence, et finit par conclure que son adresse n'est pas la bonne.
  Le compte est irrécupérable en libre-service.
- **Le défaut est invisible en supervision.** Pas d'exception, pas de `4xx`,
  pas de `5xx`, pas de `logger.error` : la seule trace est un `logger.info`
  qui indique que la demande a été *reçue*. Tous les indicateurs sont au vert.
  C'est le cas d'école du « chemin d'échec répondant 200 » : ce n'est pas une
  erreur avalée par un `catch`, c'est une erreur qui n'a jamais été levée.
- **Des jetons de réinitialisation valides s'accumulent en base**, un par
  demande, valables une heure, sans que personne ne puisse s'en servir
  légitimement. Chaque demande écrase le précédent, donc il n'y a pas
  d'accumulation illimitée — mais la colonne contient en permanence des jetons
  actifs qui n'ont aucune raison d'exister.

**Le correctif.** Deux choses, dans cet ordre :

1. **Décider et rendre l'état honnête tout de suite.** Tant que l'envoi n'est
   pas branché, la route ne doit pas prétendre le contraire : renvoyer un `501`
   (ou un `503`) avec un message explicite, et journaliser en `warn`. C'est une
   modification de quelques lignes qui transforme une panne invisible en panne
   visible — et qui permet à l'interface d'orienter l'utilisateur vers le
   support au lieu de le faire attendre.
2. **Brancher l'envoi.** `nodemailer` est déjà installé et la configuration
   SMTP est déjà là. L'envoi doit être placé **avant** le `return success`, et
   son échec doit être journalisé en `error` — sans révéler à l'appelant si
   l'adresse existe, le message prudent restant le bon choix côté réponse.

**Point annexe, même ligne — donnée personnelle dans les journaux.** Le
`logger.info` de `:461` écrit **l'adresse email en clair** dans `logs/app.log`.
La route est publique et non authentifiée : n'importe qui peut donc faire
inscrire l'adresse email de son choix dans les journaux du service, en
quantité. Journaliser `user.id` plutôt que `user.email` donne exactement la
même capacité de diagnostic sans stocker de donnée personnelle. Deux autres
cas de même nature, moins exposés car sur des routes d'administration
authentifiées :
`src/controllers/moderationController.js:1014-1015`, qui journalise sur la
route de bannissement les champs déjà extraits **puis le corps de requête
complet** (`logger.info('Body complet:', req.body)`) — la seconde ligne est un
reste de mise au point qui double la première et embarque le
`moderator_note` ; et `src/routes/searchRoutes.js:133`
(`logger.info('🔍 Recherche globale - Query params:', req.query)`), qui
journalise à chaque recherche les termes saisis par l'utilisateur.

**Vérifié.** Le `TODO` et le `return success: true` lus à
`authService.js:458-463` ; le `res.status(200).json(result)` lu à
`authController.js:195` ; la route publique confirmée à `authRoutes.js:291` ;
l'absence totale de `sendMail`/`nodemailer` dans `src/` confirmée par
recherche ; la dépendance présente confirmée à `package.json:65` ; la
configuration SMTP lue à `config/config.js:105-107`.
**Non vérifié :** si un envoi d'email est assuré hors du dépôt (par un service
tiers branché sur la base, par exemple). Rien dans le code ne le suggère, mais
je ne peux pas l'exclure depuis le dépôt seul — c'est la seule hypothèse qui
invaliderait ce constat, et elle mérite d'être confirmée ou écartée en premier.

---

## B2-08 — Les deux gestionnaires d'erreurs fatales appellent `process.exit(1)` juste après `logger.error` : la trace du plantage est perdue avant d'atteindre le disque

**Gravité : haute** — la seule erreur dont on a absolument besoin, celle qui a
tué le processus, est précisément celle qui a le plus de chances de ne jamais
être écrite.

**Emplacement :** `src/server.js:1742-1750`

```js
process.on('uncaughtException', (error) => {
  logger.error('Exception non capturée:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesse rejetée non gérée:', reason);
  process.exit(1);
});
```

**Ce qui ne va pas.** Deux défauts indépendants sur ces neuf lignes.

**1. La journalisation n'a pas le temps d'aboutir.** Les transports fichier de
winston (`src/utils/logger.js:22-37`) écrivent de façon **asynchrone**, à
travers un flux. `logger.error(...)` met le message en file d'attente et rend
la main immédiatement ; l'écriture réelle dans `logs/app.log` et
`logs/error.log` se produit à un tour de boucle ultérieur. `process.exit(1)`,
appelé à la ligne suivante, **termine le processus sans vider les flux en
attente**. Le comportement est donc une course, et elle se joue sur la ligne la
plus précieuse du journal : selon la charge et l'état du tampon, la trace du
plantage est écrite… ou perdue. Le résultat pratique est un service qui
redémarre sans que rien n'explique pourquoi — le symptôme classique du
« serveur qui tombe sans laisser de trace ».

C'est d'autant plus dommage que le reste du dispositif est correct :
`logger.js` déclare `exitOnError: false` (`:44`), précisément pour garder la
maîtrise de l'arrêt, et le gestionnaire d'erreurs Express (`server.js:939-947`)
journalise proprement avec pile, méthode, chemin et agent utilisateur. Tout
tient, sauf la sortie.

**2. `unhandledRejection` tue le serveur entier.** Ce gestionnaire s'applique à
**toute** promesse rejetée sans `catch`, y compris dans une tâche de fond, un
`cron`, une écriture d'index ou un appel réseau accessoire lancé en
« tire-et-oublie ». Une seule promesse oubliée dans un composant secondaire
suffit à faire tomber l'API complète, en coupant net toutes les requêtes en
cours. Aucun arrêt gracieux n'a lieu : contrairement au chemin `SIGTERM`/
`SIGINT` situé juste au-dessus (`:1716-1738`), qui ferme proprement le serveur
HTTP, PolicierCongo v3, la base, le réplica de lecture et Redis avant de
sortir, le chemin de plantage saute tout cela. Les connexions à la base et à
Redis sont abandonnées, et les requêtes en vol reçoivent une connexion coupée
plutôt qu'une réponse. L'auteur connaît manifestement l'arrêt gracieux — il
est écrit vingt lignes plus haut — il n'est simplement pas appliqué ici.

**Le correctif.** Attendre la fin de l'écriture avant de sortir. Winston émet
`'finish'` quand ses transports ont vidé leurs tampons :

```js
process.on('uncaughtException', (error) => {
  logger.error('Exception non capturée:', error);
  // On sort quand le journal est écrit — pas avant. Le minuteur garantit
  // qu'un transport bloqué ne laisse pas un processus zombie derrière lui.
  const done = () => process.exit(1);
  logger.on('finish', done);
  logger.end();
  setTimeout(done, 3000).unref();
});
```

Pour `unhandledRejection`, deux ajustements :

- **Ne pas sortir sur-le-champ.** Journaliser en `error`, incrémenter un
  compteur, et laisser le processus vivre : une promesse rejetée dans une
  tâche de fond ne justifie pas de couper les requêtes des utilisateurs. Si
  l'on tient à sortir — position défendable, une promesse non gérée pouvant
  laisser l'état incohérent — alors le faire **par le chemin d'arrêt gracieux
  déjà écrit** (`server.close()` puis fermeture de la base, du réplica et de
  Redis), pas par un `process.exit` sec.
- **Journaliser `promise` en plus de `reason`.** Le paramètre est déjà reçu
  et ignoré ; sans lui, on connaît l'erreur mais pas l'endroit d'où elle vient,
  ce qui est souvent l'information manquante pour un diagnostic.

**Vérifié.** Les deux gestionnaires lus à `server.js:1742-1750` ; le chemin
d'arrêt gracieux `SIGTERM`/`SIGINT` lu à `:1716-1738` et sa liste de fermetures
confirmée ; les transports fichier winston lus à `logger.js:22-37` ;
`exitOnError: false` lu à `logger.js:44` ; le gestionnaire d'erreurs Express lu
à `server.js:939-959`.
**Précision de formulation :** la perte de la trace est une course, pas une
certitude — selon l'état des tampons au moment du plantage, la ligne part
parfois. C'est ce qui rend le défaut difficile à reproduire, et c'est aussi
pourquoi il ne faut pas conclure de « on a déjà vu des traces de plantage »
que le problème n'existe pas.

### Jugé sain — le gestionnaire d'erreurs Express (`server.js:939`)

Analysé et non retenu : il journalise le message, la pile, la méthode, le
chemin, l'IP et l'agent utilisateur, puis masque les détails d'erreur en
production (`config.server.env === 'production'` → message générique) tout en
les exposant en développement. C'est exactement le comportement attendu. La
présence de `req.ip` et de l'agent utilisateur dans le journal est une donnée
personnelle au sens strict, mais elle est ici proportionnée : elle ne concerne
que les requêtes en erreur et constitue le minimum utile pour rattacher un
incident à son contexte. À conserver.

---

## B2-09 — La gestion d'erreur des appels réseau sans délai d'attente est correcte mais inatteignable dans le mode de panne qu'elle vise

**Gravité : faible en soi, mais elle annule le bénéfice d'un code par ailleurs
bien écrit.** Ce constat prolonge R4-01 sous l'angle des journaux ; le
correctif est celui de R4-01.

**Emplacements :** les sept appels sans délai d'attente recensés en R4-01, en
particulier `src/models/Notification.js:121` et `src/services/ctrTracker.js:51`.

**Ce qui ne va pas.** La gestion d'erreur de ces appels est, en elle-même,
exemplaire. `Notification.js:125` :

```js
} catch (pushError) {
  logger.warn('Envoi push automatique échoué (non bloquant):', pushError?.message || pushError);
}
```

et `ctrTracker.js:67` :

```js
} catch (error) {
  logger.warn(`⚠️ [ctrTracker] Impossible de contacter le recommandeur: ${error.message}`);
  // Non-blocking: on continue même si le tracking échoue
}
```

Niveau approprié (`warn`, pas `error` : c'est accessoire), message explicite,
caractère non bloquant assumé et commenté. Rien à redire — **sauf que ce code
ne s'exécute pas dans le cas qu'il est censé couvrir**.

Comme établi en R4-01, ni `axios` ni le `fetch` de Node n'appliquent de délai
par défaut. Face à un serveur distant qui accepte la connexion TCP puis ne
répond jamais — équilibreur saturé, panne partielle, table de suivi de
connexions pleine —, la promesse **ne se rejette pas** : elle attend. Aucune
exception n'est levée, donc aucun `catch` n'est déclenché, donc **aucune ligne
de journal n'est émise**. Le service en face est mort, et les journaux sont
parfaitement silencieux à son sujet.

**L'effet concret.** C'est le pire des cas pour un diagnostic : l'exploitant
qui cherche la cause d'un ralentissement voit des requêtes lentes ou bloquées,
consulte les journaux à la recherche d'un `warn` sur le poussoir de
notifications ou sur le recommandeur, **n'en trouve aucun**, et en déduit
raisonnablement que ces dépendances vont bien. La présence d'un `catch`
soigné renforce cette conclusion erronée : on constate que le code aurait
signalé le problème s'il y en avait eu un. Les seuls modes de panne qui
déclenchent effectivement ces `catch` sont les échecs *rapides* — DNS
introuvable, connexion refusée, réponse non-2xx — c'est-à-dire ceux qui sont
déjà les plus faciles à diagnostiquer par ailleurs.

**Le correctif.** Poser le délai d'attente, comme le prescrit R4-01 : c'est
lui qui transforme une attente muette en erreur journalisée, et il rend du même
coup opérant tout le `catch` déjà écrit. Aucune modification n'est nécessaire
dans les blocs `catch` eux-mêmes — ils sont bons. Le seul ajout utile, une
fois le délai posé, serait de distinguer le dépassement de délai des autres
échecs dans le message (`error.code === 'ECONNABORTED'` pour axios,
`AbortError` pour `fetch`), une dépendance lente et une dépendance absente
n'appelant pas la même action.

**Vérifié.** Les deux blocs `catch` lus à `Notification.js:125-127` et
`ctrTracker.js:67-70` ; l'absence d'option `timeout` sur les appels
correspondants (`Notification.js:121-123`, `ctrTracker.js:51-58`) confirmée par
lecture ; le recensement des sept appels sans délai repris de R4-01, où il a
été établi.

---

# Récapitulatif de la section B2

| # | Constat | Gravité |
|---|---|---|
| B2-02 | Identité utilisateur écrite sur disque, jamais purgée, `temp/` non ignoré → 13 fichiers dans un dépôt public | **Critique** |
| B2-01 | `Float32Array(256)` vs `DIMS = 768` → flot d'avertissements + tweets média jamais vectorisés | **Haute** |
| B2-07 | `/forgot-password` répond `200` en annonçant un email jamais envoyé | **Haute** |
| B2-08 | `process.exit(1)` après `logger.error` → la trace du plantage se perd ; pas d'arrêt gracieux | **Haute** |
| B2-03 | Verdict de détection de bot jamais persisté ni journalisé en cas d'échec (+ recensement des `catch` vides) | **Haute** |
| B2-06 | 373 `console.*` hors winston, dont 50 `console.error` absents de `logs/error.log` | Moyenne à haute |
| B2-04 | 26 fonctions de scoring renvoient une note neutre sans aucune trace | Moyenne à haute |
| B2-05 | Sauvegarde non atomique d'un index de ~155 Mo réécrit toutes les 5 min | Moyenne |
| B2-09 | Gestion d'erreur réseau correcte mais inatteignable faute de délai d'attente | Faible (prolonge R4-01) |

## Ordre d'application conseillé

Le classement ci-dessus est par gravité ; celui-ci est par rapport
effet/effort, et ce n'est pas le même ordre.

1. **B2-02**, immédiatement et sans attendre le reste : des données
   personnelles sont publiquement exposées en ce moment. Le propriétaire a été
   notifié séparément.
2. **B2-01** : une constante à importer au lieu d'un `256` recopié. Une ligne,
   qui supprime le gros du bruit et répare un bug fonctionnel au passage.
3. **B2-06**, étape 1 seulement : remplacer les 50 `console.error` applicatifs
   par `logger.error`. Mécanique, sans risque, et `error.log` devient complet.
4. **B2-08** : attendre le vidage des tampons avant de sortir. Quelques lignes,
   et les prochains plantages deviennent explicables.
5. **B2-07** : décider — soit brancher l'envoi, soit rendre l'échec visible.
   Ne pas laisser la route mentir plus longtemps.
6. **B2-05** : `.tmp` + `rename`, trois lignes.
7. **B2-03** puis **B2-04** : rendre observables deux dégradations
   silencieuses. Plus de travail, mais c'est ce qui évitera les prochains
   diagnostics à l'aveugle.
8. **B2-09** est traité par le correctif de R4-01, rien à faire de spécifique
   ici.

## Vérifié et trouvé sain

Les recensements suivants ont été menés à leur terme ; ce qui n'apparaît pas
dans les constats ci-dessus a été examiné et jugé correct.

- **Chemins d'échec répondant `200` :** 4 occurrences dans tout `src/`
  (`routes/contestRoutes.js`, `routes/recommendationRoutes.js`,
  `controllers/twEventController.js` ×2). **Toutes saines** : chacune est
  délibérée, accompagnée d'un commentaire qui justifie le choix, et
  journalisée avant le repli. La dégradation gracieuse y est un choix explicite
  et correctement mis en œuvre — c'est précisément ce qui manque à B2-07, qui
  n'est pas dans cette liste parce que rien n'y est ni décidé ni journalisé.
- **Aides de gestion d'erreur des routes :** `fail()` dans
  `paidContentRoutes.js:56`, `eventPassRoutes.js:34`,
  `usernameMarketRoutes.js:43`, `scheduledTweetRoutes.js:37`, et
  `handleError()` dans `userCurrencyRoutes.js:37`. **Saines, et même
  exemplaires** : elles laissent passer les erreurs métier avec leur propre
  message et leur propre code HTTP (refus anti-fraude, solde insuffisant,
  course perdue sur une contrainte d'unicité → `409`), et ne journalisent en
  `error` que le cas réellement inattendu avant de renvoyer un `500` générique.
  C'est le bon équilibre entre bruit et trace ; ce motif mériterait d'être
  généralisé aux routes qui ne l'utilisent pas encore.
- **Gestionnaire d'erreurs Express** (`server.js:939`) : sain, détaillé sous
  B2-08.
- **`catch` vides délibérés :** `fraudMiddleware.js:276`, `:283`, `:356` et
  `policiercongoV2.js:677`, `:685` — analysés et écartés, motifs détaillés sous
  B2-03.
- **Compteurs d'erreurs de `featureFlagService.js`** (`:176`, `:197`, `:220`,
  `:294`, `:337`, `:372`, `:388`) : ce module dégrade en silence, mais il
  **compte** ses erreurs, ce qui rend la dégradation observable. C'est le bon
  motif, et il sert de référence au correctif proposé en B2-04.
- **Politique de dégradation de `featureFlagMiddleware.js:33`** : un drapeau
  qui ne s'évalue pas ferme la porte plutôt que de l'ouvrir, avec un
  commentaire qui l'explicite. Bon choix, conservé.
- **`catch` de `src/scripts/`** : non retenus. Ce sont des scripts
  d'administration lancés à la main, dont la sortie console est lue en direct
  par l'opérateur ; `console.*` y est le canal approprié.
