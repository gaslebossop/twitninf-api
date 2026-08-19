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
