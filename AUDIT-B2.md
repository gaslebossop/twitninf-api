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
