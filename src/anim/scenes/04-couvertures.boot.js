/* Amorcage de la scene « 04-couvertures ».

   Sorti de la page parce que l'API sert ces scenes sous une CSP
   `script-src 'self'` : un <script type="module"> en ligne y est bloque
   sans erreur visible, et la scene s'affiche alors sans personnage ni
   animation - juste le decor, qui lui est en CSS. */

import { poser, semer } from "./ninf.js";
import { drap, matelassage } from "./tissu.js";

/* La torche, en coordonnees du viewBox : tout le tissu s'eclaire
   depuis ce point, et un seul chiffre a changer si elle bouge. */
const TORCHE = [19, 96];

/* Le point de fuite de la cabane : plafond et sol y convergent tous
   les deux. Un seul chiffre, sinon la perspective se disloque. */
const FUITE = [54, 46];

/* Le fond de la cabane : un drap tombe presque droit, donc son point
   d'accroche est tres loin hors champ. Plus il est proche du cadre,
   plus les plis s'ouvrent en eventail - et on obtient un chapiteau. */
drap(document.getElementById("fond-tissu"), {
  id: "fond",
  ourlet: false,
  accroche: [48, -640],
  de: [-26, 96],
  vers: [126, 90],
  creux: 3,
  ondes: 4,
  feston: 1.1,
  nb: 13,
  sombre: "#150f0b",
  clair: "#3b2d21",
  relief: 1.1,
  source: TORCHE,
  rayon: [46, 42],
  lueur: "lueur-toile",
});

/* La retombee : le bout de drap qui pend au fond, la ou le plafond
   s'arrete. C'est le seul ourlet visible de la scene - un seul, net,
   a hauteur de ses oreilles. Plusieurs ourlets et on obtient des
   cables tendus en travers du cadre. */
drap(document.getElementById("retombee"), {
  id: "retombee",
  accroche: [54, -300],
  de: [-26, 54],
  vers: [128, 40],
  creux: 7,
  ondes: 3,
  feston: 2.2,
  nb: 9,
  sombre: "#20170f",
  clair: "#6a5136",
  relief: 1.2,
  travers: 2,
  bandes: [
    [1.4, 3.6, "#f0d6ac"],
    [4.8, 6.2, "#f0d6ac"],
  ],
  ombrePortee: 2.6,
  source: TORCHE,
  rayon: [66, 60],
  lueur: "lueur-toile",
});

/* Le plafond. Il ne rayonne PAS d'un point au-dessus : ses plis fuient
   vers le fond, au meme point que les coutures du sol. C'est toute la
   difference entre un chapiteau et un plafond bas au-dessus de la
   tete - et c'est ce qui a fait chapiteau pendant deux versions. */
drap(document.getElementById("voute"), {
  id: "voute",
  accroche: FUITE,
  de: [-56, -44],
  vers: [156, -44],
  creux: -14,
  ondes: 2,
  feston: 3,
  nb: 13,
  sombre: "#2a1e14",
  clair: "#8d6c49",
  relief: 0.85,
  ourlet: false,
  source: TORCHE,
  /* Portee large : le faisceau part du sol et remonte SUR le dessous
     du drap. C'est cette lueur au plafond qui dit qu'on est enferme
     dessous, et pas devant une tenture. */
  rayon: [80, 92],
  lueur: "lueur-toile",
  travers: 4,
  etoiles: 18,
});

/* Les deux pans qui descendent jusqu'au sol de chaque cote. Ils sont
   PRES de nous : plis larges, valeurs sourdes, et un flou de mise au
   point. C'est leur proximite qui creuse la cabane. */
drap(document.getElementById("pan-gauche"), {
  id: "pan-g",
  ourlet: false,
  accroche: [-74, -170],
  de: [-46, 122],
  vers: [10, 94],
  creux: 6,
  ondes: 2,
  feston: 1.8,
  nb: 5,
  sombre: "#170f0a",
  clair: "#54402d",
  relief: 1.5,
  ombrePortee: 2.2,
  source: TORCHE,
  rayon: [42, 40],
  lueur: "lueur-toile",
});

/* Le pan droit ferme la cabane du cote du dehors. La torche ne
   l'atteint presque pas : c'est le noir sur lequel la fente lilas se
   detache. */
drap(document.getElementById("pan-droit"), {
  id: "pan-d",
  ourlet: false,
  accroche: [172, -190],
  de: [96, 92],
  vers: [152, 122],
  creux: 5,
  ondes: 2,
  feston: 1.6,
  nb: 5,
  sombre: "#130d09",
  clair: "#3a2b1e",
  relief: 1.4,
  ombrePortee: 2,
  source: TORCHE,
  rayon: [36, 34],
  lueur: "lueur-toile",
});

/* Le sol : une couverture matelassee, pas un plancher. Les coutures
   du matelassage fuient vers le fond, c'est ce qui donne la
   profondeur sans dessiner une seule ligne d'horizon. */
matelassage(document.getElementById("matelas"), {
  id: "sol",
  haut: 76,
  fuite: FUITE,
  source: TORCHE,
  rayon: [54, 34],
  lueur: "lueur-sol",
});

await poser(document.getElementById("perso"));

/* Poussieres dans le faisceau seulement : elles montent en diagonale
   depuis la torche vers elle, pas partout dans le cadre. */
semer(document.getElementById("particules"), 26, {
  teinte: "rgba(255, 216, 168, 0.95)",
  zoneX: [16, 60],
  zoneY: [50, 84],
  dureeMin: 7,
  dureeMax: 15,
  pic: 0.7,
  derive: 22,
});
