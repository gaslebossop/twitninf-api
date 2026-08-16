/* Amorcage de la scene « 05-feu-de-camp ».

   Sorti de la page parce que l'API sert ces scenes sous une CSP
   `script-src 'self'` : un <script type="module"> en ligne y est bloque
   sans erreur visible, et la scene s'affiche alors sans personnage ni
   animation - juste le decor, qui lui est en CSS. */

import { poser, semer, montrer } from "./ninf.js";
import { matelassage } from "./tissu.js";

/* Le foyer, en coordonnees du viewBox. Tout part de ce point : le
   matelassage s'y eclaire, les etincelles en montent. */
const FOYER = [28, 104];

/* Elle a etale sa couverture par terre - la meme matiere que la
   cabane de la scene 4, c'est ce qui relie les deux dernieres. */
matelassage(document.getElementById("couverture"), {
  id: "camp",
  haut: 84,
  fuite: [52, 62],
  laine: "#6f4630",
  nuit: "#20140e",
  source: FOYER,
  rayon: [52, 30],
  lueur: "lueur-sol",
});

const perso = document.getElementById("perso");
await poser(perso);

/* Second calque d'eclairage : .eclairage porte deja l'ambre du feu par
   en dessous, celui-ci pose le froid de la lune sur son epaule droite.
   C'est cette pincee de lilas qui l'empeche de fondre dans l'ambre. */
const froid = document.createElement("div");
froid.className = "eclairage";
froid.style.cssText =
  "--teinte: rgba(178, 158, 224, 0.6); --sens: 232deg; opacity: 0.8";
perso.appendChild(froid);

/* Le bord chaud jete par les flammes. En screen et non en soft-light :
   sur une peluche sombre devant une nuit sombre, le soft-light ne
   souleve rien et elle reste plate. Il bat sur le temps du feu. */
const braise = document.createElement("div");
braise.className = "eclairage";
braise.style.cssText =
  "--teinte: rgba(255, 166, 76, 0.5); --sens: 26deg;" +
  "mix-blend-mode: screen; opacity: 0.2;" +
  "animation: braise 3.7s ease-in-out infinite";
perso.appendChild(braise);

/* Les etincelles montent du foyer, pas du cadre : zone etroite, longue
   derive laterale, durees toutes differentes. */
semer(document.getElementById("etincelles"), 30, {
  teinte: "rgba(255, 196, 118, 0.95)",
  tailleMin: 1.2,
  tailleMax: 3,
  zoneX: [16, 42],
  zoneY: [66, 84],
  dureeMin: 4,
  dureeMax: 11,
  pic: 0.85,
  derive: 34,
});

/* Tout est monte : la scene peut se montrer. Avant cet appel elle est a
   `opacity: 0` - voir `.scene.prete` dans scene.css. */
montrer(document.getElementById("perso"));
