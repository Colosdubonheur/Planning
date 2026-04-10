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

// ── Date helpers (used by buildEmptyState + state.mjs setSchedule op) ──
const FR_WEEKDAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long" });
const FR_SHORT_DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

function frenchDayName(date) {
  const name = FR_WEEKDAY.format(date);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function frenchShortDate(date) {
  // fr-FR formatter appends a trailing "." to abbreviated months ("avr.").
  // Strip it to match the look of the original seed data ("11 avr").
  return FR_SHORT_DATE.format(date).replace(/\.$/, "");
}

// Build a days array of length `count` starting at the given ISO date
// (YYYY-MM-DD).  Day IDs are stable (`j1`..`jN`) so existing tasks survive
// rescheduling as long as their dayId is still in range.
export function buildDaysFromStart(startISO, count) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startISO || ""));
  if (!m) throw new Error("Date de début invalide (format YYYY-MM-DD attendu)");
  const year = +m[1], month = +m[2], day = +m[3];
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    throw new Error("Date de début invalide");
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    throw new Error("Nombre de jours invalide (1-31)");
  }
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(year, month - 1, day + i);
    const dow = d.getDay(); // 0 = Sunday, 6 = Saturday
    days.push({
      id: `j${i + 1}`,
      short: `J${i + 1}`,
      name: frenchDayName(d),
      date: frenchShortDate(d),
      weekend: dow === 0 || dow === 6,
    });
  }
  return days;
}

// Build a fresh, empty state for a new planning.  No pre-seeded tasks; the
// caller specifies the start date and length.
export function buildEmptyState({ startDate, dayCount } = {}) {
  const days = buildDaysFromStart(startDate, dayCount);
  return {
    days,
    slots: SLOTS,
    tasks: [],
    startDate,
    version: 1,
    lastUpdated: Date.now(),
  };
}

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
