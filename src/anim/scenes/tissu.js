/* Primitives de tissu.

   Un drap ne se lit pas a son aplat. Il se lit a trois choses :

   - ses PLIS, qui partent du point d'accroche et s'evasent vers l'ourlet ;
   - la maniere dont ils sont peints : un pli est un CREUX et une BOSSE
     qui se fondent l'un dans l'autre. Des facettes plates a arete franche
     donnent un eventail ou un chapiteau, jamais une couverture. Chaque
     fuseau porte donc un degrade en travers, pas une couleur ;
   - son OURLET : un bourrelet sombre, un rebord qui prend la lumiere, une
     piqure en pointilles au-dessus. Trois traits, pas un.

   La lumiere ne fait pas partie du dessin : elle passe apres, en un calque
   « screen » decoupe a la forme du drap. Un drap eclaire garde donc ses
   plis au lieu d'etre delave. */

const NS = "http://www.w3.org/2000/svg";

const el = (nom, attrs = {}) => {
  const e = document.createElementNS(NS, nom);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

const n2 = (v) => v.toFixed(2);

/* Melange deux couleurs hex. Evite d'ecrire quinze constantes pour etaler
   les valeurs. */
function melange(a, b, k) {
  const lit = (c) => [1, 3, 5].map((i) => parseInt(c.substr(i, 2), 16));
  const [r1, v1, b1] = lit(a);
  const [r2, v2, b2] = lit(b);
  const c = (x, y) =>
    Math.round(x + (y - x) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r1, r2)}${c(v1, v2)}${c(b1, b2)}`;
}

/* Petite etoile a quatre branches, la meme que celles de son manteau : le
   drap est le sien, pas un drap generique. */
const etoile = (x, y, r) => {
  const p = r * 0.2;
  return (
    `M ${n2(x)} ${n2(y - r)} Q ${n2(x + p)} ${n2(y - p)} ${n2(x + r)} ${n2(y)} ` +
    `Q ${n2(x + p)} ${n2(y + p)} ${n2(x)} ${n2(y + r)} ` +
    `Q ${n2(x - p)} ${n2(y + p)} ${n2(x - r)} ${n2(y)} ` +
    `Q ${n2(x - p)} ${n2(y - p)} ${n2(x)} ${n2(y - r)} Z`
  );
};

/* Suite pseudo-aleatoire deterministe : deux chargements de la meme scene
   doivent donner le meme drap, sinon le splash « clignote » d'une fois sur
   l'autre. */
function des(graine) {
  let s = graine;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/* Un masque a la forme du halo de la source.
   Sert aux coutures : un fil ne brille QUE la ou la lumiere l'atteint. Une
   piqure eclairee d'un bout a l'autre du cadre ne se lit pas comme une
   couture, elle se lit comme un cable. */
function masqueLumiere(defs, id, source, rayon) {
  const g = el("radialGradient", { id: `mg-${id}` });
  [
    ["0%", "#ffffff", 1],
    ["46%", "#ffffff", 0.72],
    ["100%", "#000000", 1],
  ].forEach(([offset, c, op]) =>
    g.appendChild(el("stop", { offset, "stop-color": c, "stop-opacity": op })),
  );
  defs.appendChild(g);

  const m = el("mask", {
    id: `ml-${id}`,
    maskUnits: "userSpaceOnUse",
    x: "-60",
    y: "-60",
    width: "260",
    height: "280",
  });
  m.appendChild(el("rect", { x: -60, y: -60, width: 260, height: 280, fill: "#000" }));
  m.appendChild(
    el("ellipse", {
      cx: source[0],
      cy: source[1],
      rx: rayon[0] * 1.15,
      ry: rayon[1] * 1.15,
      fill: `url(#mg-${id})`,
    }),
  );
  defs.appendChild(m);
  return `ml-${id}`;
}

/* Passe une courbe douce par une suite de points. Une polyligne, sur du
   tissu, se voit immediatement : elle fait cassure. */
function courbe(pts) {
  if (pts.length < 3) return `M ${pts.map((p) => `${n2(p[0])} ${n2(p[1])}`).join(" L ")}`;
  let d = `M ${n2(pts[0][0])} ${n2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${n2(pts[i][0])} ${n2(pts[i][1])} ${n2(mx)} ${n2(my)}`;
  }
  const f = pts[pts.length - 1];
  return `${d} L ${n2(f[0])} ${n2(f[1])}`;
}

/* Cote d'un pli : jamais une droite. Une legere courbure suffit a enlever
   le cote « rayon de roue ». */
function bras(a, b, bombe) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [mx - (dy / l) * bombe, my + (dx / l) * bombe];
}

/* ------------------------------------------------------------------ */

/**
 * Un drap tendu, vu de dessous.
 *
 * accroche  [x, y]  le point d'ou partent les plis. Le mettre LOIN hors
 *                   champ : proche du cadre, les fuseaux s'ouvrent en
 *                   eventail et la scene devient un chapiteau.
 * de / vers [x, y]  les deux extremites de l'ourlet
 * creux             affaissement de l'ourlet en son milieu
 * ondes / feston    les vagues de l'ourlet : un drap ne pend pas droit
 * nb                nombre de plis
 * sombre / clair    les deux valeurs entre lesquelles l'etoffe s'etale
 * relief            force des creux et bosses (0.6 = drap fin, 1.4 = laine)
 * source [x, y]     d'ou vient la lumiere, en coordonnees du viewBox
 * rayon  [rx, ry]   portee de cette lumiere
 * lueur             id du degrade radial a utiliser pour elle
 * etoiles           nombre d'etoiles brodees (0 = aucune)
 */
export function drap(cible, o) {
  const {
    id,
    accroche,
    de,
    vers,
    creux = 10,
    ondes = 3,
    feston = 1.6,
    nb = 12,
    sombre = "#241a13",
    clair = "#6d5540",
    relief = 1,
    source,
    rayon = [50, 44],
    lueur,
    etoiles = 0,
    piqure = "rgba(228, 214, 188, 0.4)",
    rebord = "255, 196, 134",
  } = o;

  const tire = des(id.length * 7919 + nb);
  const defs = el("defs");
  cible.appendChild(defs);

  /* L'ourlet, parametre de 0 a 1 : une chute lineaire, un affaissement au
     milieu, des festons par-dessus. */
  const bord = (t) => [
    de[0] + (vers[0] - de[0]) * t,
    de[1] +
      (vers[1] - de[1]) * t +
      creux * Math.sin(Math.PI * t) +
      feston * Math.sin(Math.PI * 2 * ondes * t),
  ];

  /* Les pieds des plis ne sont pas regulierement espaces : un drap reel
     fronce par paquets. */
  const bornes = [0];
  const brut = Array.from({ length: nb }, () => 0.6 + tire() * 0.8);
  const total = brut.reduce((a, b) => a + b, 0);
  brut.forEach((v) => bornes.push(bornes[bornes.length - 1] + v / total));
  const pied = bornes.map(bord);

  const fin = Array.from({ length: 73 }, (_, i) => bord(i / 72));
  const suite = fin.map((p) => `${n2(p[0])} ${n2(p[1])}`).join(" L ");
  const ligne = `M ${suite}`;
  const contour = `M ${n2(accroche[0])} ${n2(accroche[1])} L ${suite} Z`;

  const coupe = el("clipPath", { id: `coupe-${id}` });
  coupe.appendChild(el("path", { d: contour }));
  defs.appendChild(coupe);

  /* Le flou des plis : c'est lui qui fait la difference entre une etoffe
     et un origami. Il ne touche ni l'ourlet ni les piqures, qui doivent
     rester nets. */
  const flou = el("filter", {
    id: `flou-${id}`,
    x: "-20%",
    y: "-20%",
    width: "140%",
    height: "140%",
  });
  flou.appendChild(el("feGaussianBlur", { stdDeviation: 0.55 }));
  defs.appendChild(flou);

  /* --- l'etoffe, d'un seul tenant --- */
  /* Sombre pres de l'accroche (le tissu s'y entasse et mange le jour),
     plus ouvert vers l'ourlet. */
  const mi = bord(0.5);
  const fondu = el("linearGradient", {
    id: `fond-${id}`,
    gradientUnits: "userSpaceOnUse",
    x1: n2(accroche[0]),
    y1: n2(accroche[1]),
    x2: n2(mi[0]),
    y2: n2(mi[1]),
  });
  [
    ["0%", melange(sombre, "#000000", 0.35)],
    ["46%", sombre],
    ["100%", melange(sombre, clair, 0.5)],
  ].forEach(([offset, c]) => fondu.appendChild(el("stop", { offset, "stop-color": c })));
  defs.appendChild(fondu);
  cible.appendChild(el("path", { d: contour, fill: `url(#fond-${id})` }));

  /* --- creux et bosses --- */
  /* Chaque fuseau porte un degrade EN TRAVERS : creux sombre d'un cote,
     bosse claire de l'autre, fondus l'un dans l'autre. C'est ce qui donne
     un pli rond au lieu d'une facette. */
  const plis = el("g", { filter: `url(#flou-${id})` });
  for (let i = 0; i < nb; i++) {
    const a = pied[i];
    const b = pied[i + 1];
    const force = (0.55 + tire() * 0.75) * relief;
    const g = el("linearGradient", {
      id: `pli-${id}-${i}`,
      gradientUnits: "userSpaceOnUse",
      x1: n2(a[0]),
      y1: n2(a[1]),
      x2: n2(b[0]),
      y2: n2(b[1]),
    });
    [
      ["0%", "0,0,0", 0.34 * force],
      ["26%", "0,0,0", 0.1 * force],
      ["52%", "255,232,198", 0.07 * force],
      ["74%", "255,232,198", 0.03 * force],
      ["100%", "0,0,0", 0.3 * force],
    ].forEach(([offset, rgb, op]) =>
      g.appendChild(
        el("stop", { offset, "stop-color": `rgb(${rgb})`, "stop-opacity": op.toFixed(3) }),
      ),
    );
    defs.appendChild(g);

    const bombe = (tire() - 0.5) * 3.4;
    const ca = bras(accroche, a, bombe);
    const cb = bras(b, accroche, bombe);
    plis.appendChild(
      el("path", {
        d:
          `M ${n2(accroche[0])} ${n2(accroche[1])} ` +
          `Q ${n2(ca[0])} ${n2(ca[1])} ${n2(a[0])} ${n2(a[1])} ` +
          `L ${n2(b[0])} ${n2(b[1])} ` +
          `Q ${n2(cb[0])} ${n2(cb[1])} ${n2(accroche[0])} ${n2(accroche[1])} Z`,
        fill: `url(#pli-${id}-${i})`,
      }),
    );
  }
  cible.appendChild(plis);

  /* --- les bandes de bordure --- */
  /* Ce qui fait lire « couverture » plutot que « rideau », c'est le motif.
     Deux bandes paralleles a l'ourlet suffisent - c'est la bordure de
     toutes les couvertures de lit. Elles passent en soft-light : elles
     n'existent que la ou la lumiere tombe, et restent noires ailleurs. */
  if (o.bandes) {
    const g = el("g", { "clip-path": `url(#coupe-${id})`, opacity: 0.34 });
    g.style.mixBlendMode = "soft-light";

    /* Les distances sont comptees EN UNITES depuis l'ourlet, jamais en
       fraction du fuseau : l'accroche est a des centaines d'unites hors
       champ, une fraction envoie la bordure au milieu du drap. */
    const recule = (d) =>
      pied.map((p) => {
        const dx = p[0] - accroche[0];
        const dy = p[1] - accroche[1];
        const l = Math.hypot(dx, dy) || 1;
        return [p[0] - (dx / l) * d, p[1] - (dy / l) * d];
      });

    o.bandes.forEach(([d1, d2, couleur]) => {
      g.appendChild(
        el("path", {
          d: `${courbe(recule(d1))} ${courbe(recule(d2).reverse()).replace(/^M/, "L")} Z`,
          fill: couleur,
        }),
      );
    });
    cible.appendChild(g);
  }

  /* --- les faux plis en travers --- */
  /* Un tissu n'a pas que des plis dans le sens de la tension : il garde
     les marques de la fois ou il a ete plie. Sans eux, les fuseaux se
     lisent comme des rayons de lumiere - c'est le defaut qui donnait un
     chapiteau. */
  if (o.travers) {
    const g = el("g", { "clip-path": `url(#coupe-${id})`, filter: `url(#flou-${id})` });
    for (let k = 1; k <= o.travers; k++) {
      const f = 0.24 + (k / (o.travers + 1)) * 0.8;
      /* L'ondulation reste minuscule et lente : plus franche, on obtient
         une toile d'araignee au lieu d'un faux pli. */
      const pts = pied.map((p, i) => {
        const j = f * (1 + 0.055 * Math.sin(i * 0.62 + k * 1.4));
        return [
          accroche[0] + (p[0] - accroche[0]) * j,
          accroche[1] + (p[1] - accroche[1]) * j,
        ];
      });
      const d = courbe(pts);
      g.appendChild(
        el("path", { d, fill: "none", stroke: "rgba(0, 0, 0, 0.2)", "stroke-width": 0.8 }),
      );
      g.appendChild(
        el("path", {
          d,
          fill: "none",
          stroke: "rgba(255, 230, 194, 0.05)",
          "stroke-width": 0.6,
          transform: "translate(0 -1)",
        }),
      );
    }
    cible.appendChild(g);
  }

  /* --- les etoiles brodees --- */
  if (etoiles) {
    const g = el("g", { "clip-path": `url(#coupe-${id})` });
    for (let i = 0; i < etoiles; i++) {
      const p = bord(tire());
      const k = 0.36 + tire() * 0.56;
      g.appendChild(
        el("path", {
          d: etoile(
            accroche[0] + (p[0] - accroche[0]) * k,
            accroche[1] + (p[1] - accroche[1]) * k,
            0.6 + tire() * 0.8,
          ),
          fill: "#e6dcc6",
          opacity: (0.14 + tire() * 0.28).toFixed(2),
        }),
      );
    }
    cible.appendChild(g);
  }

  /* --- l'ombre que l'ourlet jette derriere lui --- */
  /* Sans elle, l'ourlet est un trait pose sur un fond : il se lit comme
     une corde tendue. Avec elle, il devient le BORD d'une etoffe qui a du
     tissu devant et du vide derriere. */
  if (o.ombrePortee) {
    const ombre = el("filter", {
      id: `ombre-${id}`,
      x: "-20%",
      y: "-40%",
      width: "140%",
      height: "220%",
    });
    ombre.appendChild(el("feGaussianBlur", { stdDeviation: o.ombrePortee * 0.7 }));
    defs.appendChild(ombre);
    cible.appendChild(
      el("path", {
        d: ligne,
        fill: "none",
        stroke: "rgba(0, 0, 0, 0.5)",
        "stroke-width": o.ombrePortee * 2.6,
        "stroke-linecap": "round",
        filter: `url(#ombre-${id})`,
        transform: `translate(0 ${n2(o.ombrePortee * 1.5)})`,
      }),
    );
  }

  /* --- l'ourlet --- */
  /* Le bourrelet sombre existe toujours : c'est lui qui donne l'epaisseur.
     Le rebord clair et la piqure, eux, passent dans le masque de lumiere -
     ils n'apparaissent que dans le halo de la torche. Sans ce masque on
     obtient deux cables lumineux tendus en travers du cadre.

     Les pans qui meurent dans le noir passent ourlet:false : un drap qui
     retombe au sol n'a pas de rebord eclaire. */
  if (o.ourlet !== false) {
    cible.appendChild(
      el("path", {
        d: ligne,
        fill: "none",
        stroke: "rgba(0, 0, 0, 0.5)",
        "stroke-width": 1.5,
        "stroke-linecap": "round",
      }),
    );

    const couture = el("g");
    if (source) {
      couture.setAttribute("mask", `url(#${masqueLumiere(defs, id, source, rayon)})`);
    }
    couture.appendChild(
      el("path", {
        d: ligne,
        fill: "none",
        stroke: `rgba(${rebord}, 0.5)`,
        "stroke-width": 0.45,
        "stroke-linecap": "round",
        transform: "translate(0 -0.8)",
      }),
    );
    couture.appendChild(
      el("path", {
        d: ligne,
        fill: "none",
        stroke: piqure,
        "stroke-width": 0.28,
        "stroke-dasharray": "1.2 1.8",
        opacity: 0.6,
        transform: "translate(0 -2.5)",
      }),
    );
    cible.appendChild(couture);
  }

  /* --- la lumiere, par-dessus --- */
  if (source && lueur) {
    const g = el("g", { "clip-path": `url(#coupe-${id})` });
    g.style.mixBlendMode = "screen";
    g.appendChild(
      el("ellipse", {
        cx: source[0],
        cy: source[1],
        rx: rayon[0],
        ry: rayon[1],
        fill: `url(#${lueur})`,
      }),
    );
    cible.appendChild(g);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Une couverture matelassee posee au sol.
 *
 * Les coutures du matelassage fuient vers un point au fond : c'est ce qui
 * donne la profondeur, sans jamais dessiner de ligne d'horizon - une ligne
 * droite en travers du cadre ferait « decor de theatre ».
 */
export function matelassage(cible, o) {
  const {
    id,
    haut = 76,
    fuite = [54, 52],
    source,
    rayon = [54, 34],
    lueur,
    laine = "#7d4f33",
    nuit = "#2b1a12",
    piqure = "rgba(232, 214, 184, 0.26)",
  } = o;

  const tire = des(id.length * 104729 + haut);

  /* Le bord du fond n'est pas une droite : une ligne nette en travers du
     cadre se lit comme une plinthe, et la couverture redevient un
     plancher. Elle se froisse la ou elle rejoint le drap du fond. */
  const arriere = (t) =>
    haut -
    3 * t +
    1.9 * Math.sin(Math.PI * 2.4 * t + 0.7) +
    1.1 * Math.sin(Math.PI * 5.3 * t);
  const creteX = Array.from({ length: 41 }, (_, i) => -30 + (i / 40) * 160);
  const crete =
    "M " + creteX.map((x, i) => `${n2(x)} ${n2(arriere(i / 40))}`).join(" L ");
  const zone = `${crete} L 130 132 L -30 132 Z`;

  const defs = el("defs");
  const coupe = el("clipPath", { id: `coupe-${id}` });
  coupe.appendChild(el("path", { d: zone }));
  defs.appendChild(coupe);

  const flou = el("filter", {
    id: `flou-${id}`,
    x: "-30%",
    y: "-120%",
    width: "160%",
    height: "340%",
  });
  flou.appendChild(el("feGaussianBlur", { stdDeviation: 0.5 }));
  defs.appendChild(flou);

  /* Degrade de la laine : claire juste devant elle, sourde au fond et sur
     les bords. */
  const grad = el("linearGradient", {
    id: `laine-${id}`,
    x1: "0",
    y1: String(haut),
    x2: "0",
    y2: "132",
    gradientUnits: "userSpaceOnUse",
  });
  [
    ["0%", nuit],
    ["18%", melange(nuit, laine, 0.72)],
    ["44%", laine],
    ["80%", melange(nuit, laine, 0.4)],
    ["100%", nuit],
  ].forEach(([offset, couleur]) =>
    grad.appendChild(el("stop", { offset, "stop-color": couleur })),
  );
  defs.appendChild(grad);
  cible.appendChild(defs);

  cible.appendChild(el("path", { d: zone, fill: `url(#laine-${id})` }));

  /* Le creux ou la couverture rejoint le drap du fond : c'est ce pincement
     sombre qui pose le sol au lieu de le coller au mur. */
  cible.appendChild(
    el("path", {
      d: crete,
      fill: "none",
      stroke: "rgba(0, 0, 0, 0.55)",
      "stroke-width": 3.4,
      filter: `url(#flou-${id})`,
      transform: "translate(0 0.8)",
    }),
  );

  /* Le rembourrage passe avant les coutures : les bosses portent le
     volume, les coutures viennent les pincer. */
  const bosses = el("g", { "clip-path": `url(#coupe-${id})`, filter: `url(#flou-${id})` });
  for (let i = 0; i < 30; i++) {
    const rx = 6 + tire() * 11;
    bosses.appendChild(
      el("ellipse", {
        cx: n2(-20 + tire() * 140),
        cy: n2(haut + tire() * 54),
        rx: n2(rx),
        ry: n2(rx * 0.4),
        fill: tire() > 0.45 ? "rgba(0, 0, 0, 0.22)" : "rgba(255, 206, 152, 0.07)",
      }),
    );
  }
  cible.appendChild(bosses);

  /* Le patchwork.

     C'est lui qui fait dire « couverture » en un coup d'oeil : une laine
     unie se lit comme un sol, un assemblage de carres se lit comme du
     matelasse. Deux series de bandes alternees se croisent - leurs
     recoupements donnent quatre valeurs, donc des carres, sans avoir a
     calculer une seule cellule. En soft-light : rien n'apparait hors du
     halo de la torche. */
  const carreaux = el("g", { "clip-path": `url(#coupe-${id})` });
  carreaux.style.mixBlendMode = "soft-light";
  for (let i = -7; i < 7; i += 2) {
    carreaux.appendChild(
      el("path", {
        d:
          `M ${n2(fuite[0] + i * 8.4)} ${n2(arriere(0.5))} ` +
          `L ${n2(fuite[0] + (i + 1) * 8.4)} ${n2(arriere(0.5))} ` +
          `L ${n2(fuite[0] + (i + 1) * 29)} 134 L ${n2(fuite[0] + i * 29)} 134 Z`,
        fill: "#e8c89a",
        opacity: 0.5,
      }),
    );
  }
  {
    let y = haut + 3.2;
    let pas = 3.8;
    let pair = true;
    while (y < 134) {
      if (pair) {
        carreaux.appendChild(
          el("path", {
            d:
              `M -30 ${n2(y + 2)} Q 50 ${n2(y + 1.4)} 130 ${n2(y - 1.6)} ` +
              `L 130 ${n2(y - 1.6 + pas)} Q 50 ${n2(y + 1.4 + pas)} -30 ${n2(y + 2 + pas)} Z`,
            fill: "#f0d3a6",
            opacity: 0.42,
          }),
        );
      }
      pair = !pair;
      y += pas;
      pas *= 1.3;
    }
  }
  cible.appendChild(carreaux);

  /* Les coutures du matelassage.

     Deux pieges evites ici. Les creux passent en valeur tres basse : plus
     francs, la couverture devient un carrelage. Et les fils ne sont traces
     QUE dans le halo de la torche - une grille de piqures nette d'un bord
     a l'autre du cadre ferait nappe a carreaux. */
  const creuse = el("g", { "clip-path": `url(#coupe-${id})`, filter: `url(#flou-${id})` });
  const fil = el("g", { "clip-path": `url(#coupe-${id})` });
  if (source) fil.setAttribute("mask", `url(#${masqueLumiere(defs, id, source, rayon)})`);

  const trace = (d, decal) => {
    creuse.appendChild(
      el("path", { d, fill: "none", stroke: "rgba(0, 0, 0, 0.2)", "stroke-width": 1.1 }),
    );
    fil.appendChild(
      el("path", {
        d,
        fill: "none",
        stroke: piqure,
        "stroke-width": 0.26,
        "stroke-dasharray": "1.1 2.1",
        transform: `translate(${decal})`,
      }),
    );
  };

  /* Coutures qui fuient vers le fond. Espacement irregulier : regulier,
     l'oeil y lit une perspective de carrelage. */
  for (let i = -7; i <= 7; i++) {
    const jeu = (tire() - 0.5) * 3.2;
    trace(
      `M ${n2(fuite[0] + i * 8.4 + jeu * 0.3)} ${n2(arriere(0.5))} ` +
        `L ${n2(fuite[0] + i * 29 + jeu)} 134`,
      "0.5 0",
    );
  }

  /* Coutures en travers : elles se resserrent en s'eloignant. */
  let y = haut + 3.2;
  let pas = 3.8;
  while (y < 134) {
    const creux = 1.1 + tire() * 0.9;
    trace(`M -30 ${n2(y + 2)} Q 50 ${n2(y + creux)} 130 ${n2(y - 1.6)}`, "0 -0.6");
    y += pas;
    pas *= 1.3;
  }
  cible.appendChild(creuse);
  cible.appendChild(fil);

  if (source && lueur) {
    const l = el("g", { "clip-path": `url(#coupe-${id})` });
    l.style.mixBlendMode = "screen";
    l.appendChild(
      el("ellipse", {
        cx: source[0],
        cy: source[1],
        rx: rayon[0],
        ry: rayon[1],
        fill: `url(#${lueur})`,
      }),
    );
    cible.appendChild(l);
  }
}
