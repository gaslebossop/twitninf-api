/* Bascule plein cadre.

   Les pages de ce dossier sont des maquettes : une scene 4/5 centree sur un
   fond de demonstration. Embarquee dans l'app, la meme page doit remplir la
   vue - d'ou `?plein` dans l'URL, qui pose la classe lue par scene.css.

   Fichier separe, et non un <script> en ligne : l'API sert ces pages sous une
   CSP `script-src 'self'`, qui interdit tout script en ligne. Un bloc inline y
   est bloque SANS ERREUR VISIBLE dans la page - le decor s'affiche, et tout ce
   qui depend du JS manque simplement a l'appel. */
if (location.search.includes("plein")) document.documentElement.className = "plein";
