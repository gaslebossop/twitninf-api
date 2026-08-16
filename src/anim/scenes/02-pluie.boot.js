/* Amorcage de la scene « 02-pluie ».

   Sorti de la page parce que l'API sert ces scenes sous une CSP
   `script-src 'self'` : un <script type="module"> en ligne y est bloque
   sans erreur visible, et la scene s'affiche alors sans personnage ni
   animation - juste le decor, qui lui est en CSS. */

import { poser, pleuvoir, ruisseler } from "./ninf.js";

const perso = document.getElementById("perso");
await poser(perso);

// Deuxieme calque d'eclairage, pose DANS le conteneur anime pour
// respirer avec elle : .eclairage porte le froid de la vitre par le
// haut, celui-ci le chaud de la piece par le bas.
const chaud = document.createElement("div");
chaud.className = "contre-chaud";
perso.appendChild(chaud);

pleuvoir(document.getElementById("rideau"), 90);
ruisseler(document.getElementById("ruissellement"), 9);
