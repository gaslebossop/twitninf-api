/* Amorcage de la scene « 01-chambre ».

   Sorti de la page parce que l'API sert ces scenes sous une CSP
   `script-src 'self'` : un <script type="module"> en ligne y est bloque
   sans erreur visible, et la scene s'affiche alors sans personnage ni
   animation - juste le decor, qui lui est en CSS. */

import { poser, semer } from "./ninf.js";
await poser(document.getElementById("perso"));
semer(document.getElementById("particules"), 30, {
  teinte: "rgba(255, 199, 134, 0.95)",
  zoneX: [10, 66],
  zoneY: [56, 92],
  dureeMin: 9,
  dureeMax: 18,
  pic: 0.6,
});
