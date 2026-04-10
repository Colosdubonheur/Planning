// Initial planning extracted from the original hardcoded HTML
// (public/index.html lines 360-484). Used for the first-time seed
// when the state blob is empty.

export const INITIAL_DAYS = [
  { id: "j1", short: "J1", name: "Samedi",   date: "11 avr", weekend: true  },
  { id: "j2", short: "J2", name: "Dimanche", date: "12 avr", weekend: false },
  { id: "j3", short: "J3", name: "Lundi",    date: "13 avr", weekend: false },
  { id: "j4", short: "J4", name: "Mardi",    date: "14 avr", weekend: false },
  { id: "j5", short: "J5", name: "Mercredi", date: "15 avr", weekend: false },
  { id: "j6", short: "J6", name: "Jeudi",    date: "16 avr", weekend: false },
  { id: "j7", short: "J7", name: "Vendredi", date: "17 avr", weekend: false },
  { id: "j8", short: "J8", name: "Samedi",   date: "18 avr", weekend: true  },
];

export const SLOTS = [
  { id: "matin", label: "Matin"       },
  { id: "repas", label: "Repas"       },
  { id: "aprem", label: "Après-midi"  },
];

// Matin and Aprem tasks. The Repas slot is not editable; it's shown as a
// fixed "Repas" cell.
const MATIN = {
  j1: [
    "Accueil & Présentation du stage",
    "Jeux de présentation",
    "Affiches : PE, règles de vie, attentes, critères d'éval.",
  ],
  j2: [
    "Forum",
    "Histoire / Schéma narratif",
    "Restitution de l'histoire",
    "Réglementation périscolaire / extrascolaire",
  ],
  j3: [
    "Forum",
    "Réglementation Vélo + Mer",
    "Les différentes responsabilités",
    "HAJ 1",
  ],
  j4: [
    "Forum",
    "Réglementation Bus + Camping",
    "Connaissance de l'enfant",
    "À voir selon l'heure",
  ],
  j5: [
    "Forum",
    "Vie quotidienne (hygiène, repas, aide-moi…)",
    "Journée type (aide-mémoire)",
  ],
  j6: [
    "Forum",
    "Les émotions",
    "Addictions",
  ],
  j7: [
    "Forum",
    "Grand jeu 2",
    "Grand jeu (suite)",
  ],
  j8: [
    "Kermesse",
    "Quizz final",
    "Administratif",
  ],
};

const APREM = {
  j1: [
    "Éducation populaire",
    "Valeurs de la République & Laïcité",
    "Personnages",
    "Forum + Prépa forum",
  ],
  j2: [
    "Les différents projets (PP, PE, PEDT, PA)",
    "Structure / Personnel",
    "Pharmacie / Assistant sanitaire",
    "HAJ + Prépa HAJ",
  ],
  j3: [
    "HAJ 2",
    "HAJ 3",
    "HAJ 4",
    "VSS",
  ],
  j4: [
    "UNICEF",
    "Fiche technique",
    "Grand jeu + Prépa grands jeux",
    "Éval mi-stage",
  ],
  j5: [
    "Communication",
    "LAS / VS / Maltraitance / Addictions",
    "Handicap",
    "Vie affective & sexuelle",
    "Répartition des mandats",
  ],
  j6: [
    "Jeux sportifs",
    "Prépa veillée",
    "Repas de la veillée",
  ],
  j7: [
    "Grand jeu 3",
    "Grand jeu 4",
    "Rangement salle / Ménage",
  ],
  j8: [
    "CV + Lettre de motivation",
    "Questions / Bilan",
    "Bilan de stage",
    "FIN DU STAGE 🎉",
  ],
};

let idCounter = 0;
function makeId() {
  idCounter += 1;
  return `t_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function buildInitialState() {
  const tasks = [];
  for (const day of INITIAL_DAYS) {
    (MATIN[day.id] || []).forEach((text, order) => {
      tasks.push({
        id: makeId(),
        dayId: day.id,
        slotId: "matin",
        order,
        text,
        done: false,
      });
    });
    (APREM[day.id] || []).forEach((text, order) => {
      tasks.push({
        id: makeId(),
        dayId: day.id,
        slotId: "aprem",
        order,
        text,
        done: false,
      });
    });
  }
  return {
    days: INITIAL_DAYS,
    slots: SLOTS,
    tasks,
    version: 1,
    lastUpdated: Date.now(),
  };
}
