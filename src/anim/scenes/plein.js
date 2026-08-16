/* Bascule plein cadre.

   Les pages de ce dossier sont des maquettes : une scene 4/5 centree sur un
   fond de demonstration. Embarquee dans l'app, la meme page doit remplir la
   vue - d'ou `?plein` dans l'URL, qui pose la classe lue par scene.css.

   Fichier separe, et non un <script> en ligne : l'API sert ces pages sous une
   CSP `script-src 'self'`, qui interdit tout script en ligne. Un bloc inline y
   est bloque SANS ERREUR VISIBLE dans la page - le decor s'affiche, et tout ce
   qui depend du JS manque simplement a l'appel. */
if (location.search.includes("plein")) document.documentElement.className = "plein";

/* Filet de securite.

   La scene est a `opacity: 0` jusqu'a l'appel de `montrer()`. Si l'amorcage
   echoue - fichier manquant, reseau coupe en plein chargement - cet appel
   n'arrive jamais et le cadre reste vide pour toujours. Passe ce delai on
   montre ce qu'on a : le decor seul vaut mieux que rien. */
setTimeout(function () {
  var scene = document.querySelector(".scene");
  if (scene) scene.classList.add("prete");
}, 4000);
