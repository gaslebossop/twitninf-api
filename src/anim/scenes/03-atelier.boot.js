/* Amorcage de la scene « 03-atelier ».

   Sorti de la page parce que l'API sert ces scenes sous une CSP
   `script-src 'self'` : un <script type="module"> en ligne y est bloque
   sans erreur visible, et la scene s'affiche alors sans personnage ni
   animation - juste le decor, qui lui est en CSS. */

import { poser, semer } from "./ninf.js";
await poser(document.getElementById("perso"));
semer(document.getElementById("particules"), 20, {
  teinte: "rgba(255, 214, 160, 0.9)",
  zoneX: [18, 74],
  zoneY: [40, 78],
  dureeMin: 12,
  dureeMax: 21,
  pic: 0.45,
});
