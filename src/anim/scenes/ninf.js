/* Charge le personnage articule et pose la couche de lumiere de la scene.

   Pas d'oeil dessine : la vectorisation ne connait qu'un oeil COUSU (32
   traces de fil lilas), et un oeil ouvert rapporte par-dessus se lisait
   comme une bille posee sur le crane. Le groupe #oeil reste donc dans la
   tete, immobile, tel qu'il a ete brode. */

/* Deux images d'attente : inserer le SVG dans le DOM ne veut pas dire qu'il
   est dessine. Un fichier de cette taille demande une mise en page et un
   rendu, et annoncer « prete » a l'insertion laisse voir la scene sans elle. */
const deuxImages = () =>
  new Promise((suite) => {
    let fait = false;
    const finir = () => {
      if (fait) return;
      fait = true;
      suite();
    };
    requestAnimationFrame(() => requestAnimationFrame(finir));
    /* Filet indispensable : `requestAnimationFrame` ne se declenche PAS dans
       une vue qui ne compose aucune image - onglet en arriere-plan, WebView
       pas encore a l'ecran. Sans ce delai, l'amorcage de la scene reste
       suspendu pour toujours, et la scene ne se montre jamais. */
    setTimeout(finir, 300);
  });

/* Le masque de `.eclairage` est un SECOND fichier (ninf.svg, 500 Ko). Le CSS
   ne le charge qu'au moment de peindre la couche : sans cette attente, la
   lumiere de la scene se pose sur la mascotte apres elle. On echoue en
   silence - une scene sans son calque de lumiere reste une scene. */
const masqueCharge = (url) =>
  new Promise((suite) => {
    const img = new Image();
    img.onload = img.onerror = suite;
    img.src = url;
  });

/* Devoile la scene. A appeler quand la scene a fini TOUT son montage, pluie
   et poussieres comprises : sinon elles apparaissent apres coup. */
export function montrer(conteneur) {
  const scene = conteneur.closest(".scene") || document.querySelector(".scene");
  if (scene) scene.classList.add("prete");
}

export async function poser(conteneur, chemin = "../perso/ninf-parties.svg") {
  const texte = await (await fetch(chemin)).text();
  conteneur.innerHTML = texte;

  const svg = conteneur.querySelector("svg");

  // La lumiere de la scene, decoupee a sa silhouette. Elle est posee ici,
  // dans le conteneur anime, pour rester collee a elle quand elle respire.
  const lumiere = document.createElement("div");
  lumiere.className = "eclairage";
  conteneur.appendChild(lumiere);

  await masqueCharge("../perso/ninf.svg");
  await deuxImages();

  return {
    svg,
    lumiere,
    partie: (id) => svg.querySelector("#" + id),
  };
}

/* Pluie derriere la vitre : des traits fins, jamais synchrones. Les durees
   et les retards sont tires au hasard, sinon on voit un rideau qui defile. */
export function pleuvoir(conteneur, nombre, options = {}) {
  const {
    teinte = "rgba(206, 198, 232, 0.55)",
    longueurMin = 14,
    longueurMax = 44,
    dureeMin = 0.5,
    dureeMax = 1.15,
    inclinaison = 14,
  } = options;

  const entre = (a, b) => a + Math.random() * (b - a);
  const frag = document.createDocumentFragment();

  for (let i = 0; i < nombre; i++) {
    const d = document.createElement("div");
    const l = entre(longueurMin, longueurMax);
    d.className = "trait-pluie";
    d.style.cssText = `
      left:${entre(-12, 108)}%;
      height:${l}px;
      background:linear-gradient(to bottom, transparent, ${teinte});
      opacity:${entre(0.25, 0.8).toFixed(2)};
      rotate:${inclinaison}deg;
      animation-duration:${entre(dureeMin, dureeMax).toFixed(2)}s;
      animation-delay:${(-Math.random() * dureeMax * 3).toFixed(2)}s;`;
    frag.appendChild(d);
  }
  conteneur.appendChild(frag);
}

/* Gouttes sur la vitre. Une goutte reelle hesite, retient, puis file :
   d'ou une courbe d'acceleration marquee et de longues attentes. */
export function ruisseler(conteneur, nombre, options = {}) {
  const { dureeMin = 5, dureeMax = 13 } = options;
  const entre = (a, b) => a + Math.random() * (b - a);
  const frag = document.createDocumentFragment();

  for (let i = 0; i < nombre; i++) {
    const d = document.createElement("div");
    const t = entre(3, 7);
    d.className = "goutte";
    d.style.cssText = `
      left:${entre(4, 94)}%;
      top:${entre(-6, 40)}%;
      width:${t}px; height:${t * 1.25}px;
      --chute:${entre(120, 320).toFixed(0)}px;
      animation-duration:${entre(dureeMin, dureeMax).toFixed(1)}s;
      animation-delay:${(-Math.random() * dureeMax).toFixed(1)}s;`;
    frag.appendChild(d);
  }
  conteneur.appendChild(frag);
}

/* Poussieres / braises / gouttes : meme primitive, la scene choisit la
   teinte, la taille et la vitesse. */
export function semer(conteneur, nombre, options = {}) {
  const {
    teinte = "var(--ambre)",
    tailleMin = 1.5,
    tailleMax = 3.5,
    dureeMin = 7,
    dureeMax = 14,
    zoneX = [10, 90],
    zoneY = [55, 95],
    pic = 0.7,
    derive = 26,
  } = options;

  const entre = (a, b) => a + Math.random() * (b - a);
  const frag = document.createDocumentFragment();

  for (let i = 0; i < nombre; i++) {
    const d = document.createElement("div");
    const t = entre(tailleMin, tailleMax);
    d.className = "poussiere";
    d.style.cssText = `
      width:${t}px; height:${t}px;
      left:${entre(...zoneX)}%; top:${entre(...zoneY)}%;
      background:${teinte};
      --pic:${entre(pic * 0.5, pic).toFixed(2)};
      --derive:${entre(-derive, derive).toFixed(0)}px;
      animation-duration:${entre(dureeMin, dureeMax).toFixed(1)}s;
      animation-delay:${(-Math.random() * dureeMax).toFixed(1)}s;`;
    frag.appendChild(d);
  }
  conteneur.appendChild(frag);
}
