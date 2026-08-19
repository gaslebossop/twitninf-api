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
